(function(){
  'use strict';
  const VERSION='0.2.0';
  const C=globalThis.GovoriCore;
  const $=id=>document.getElementById(id);
  const canvas=$('stage'),ctx=canvas.getContext('2d',{alpha:false}),source=$('source');
  let cameraStream=null,cameraState='off',cameraRequest=0,raf=null;
  let topic='Газета',wordBag=[],remaining=C.duration($('duration').value);
  let result=null,recovery=null,validating=false,sharing=false,lastError='',wakeLock=null,wakeGeneration=0;
  let cameraInfo=null,fileInfo=null,latestStop='',lastCountdown=-1;
  const supports=()=>Boolean(ctx&&isSecureContext&&navigator.mediaDevices?.getUserMedia&&globalThis.MediaRecorder&&typeof canvas.captureStream==='function');

  function notice(message){$('notice').textContent=message||'';$('notice').hidden=!message;}
  function setError(error){lastError=error?.message||String(error);notice(lastError);updateDebug();}
  function settings(){return{topic,duration:C.duration($('duration').value),framing:$('framing').value,mirror:$('mirror').checked,width:canvas.width,height:canvas.height};}

  const session=new globalThis.GovoriCapture({
    canvas,
    beforeStart:()=>renderStage(),
    onState:(state)=>{
      if(state==='countdown'){
        notice('');$('playback').pause();requestWakeLock();
      }
      if(state==='idle')releaseWakeLock();
      updateUI();updateDebug();
    },
    onTick:tick=>{
      remaining=tick.remaining;
      $('timer').textContent=C.formatTime(remaining);
      $('countdown').hidden=!tick.countdown;
      if(lastCountdown!==tick.countdown){$('countdown').textContent=tick.countdown?String(tick.countdown):'';lastCountdown=tick.countdown;}
      renderStage();
    },
    onResult:take=>{void receiveResult(take);},
    onError:error=>{
      releaseCamera();releaseWakeLock();setError(error);updateUI();
    }
  });

  function updateUI(){
    const busy=session.busy||validating;
    const opening=cameraState==='opening';
    for(const id of ['next','duration','framing','quality','mirror'])$(id).disabled=busy||opening;
    $('camera').disabled=busy;
    $('camera').textContent=opening?'Отменить включение':cameraState==='ready'?'Выключить камеру':'Включить камеру';
    $('record').disabled=busy||cameraState!=='ready'||!supports();
    $('stop').disabled=!['countdown','starting','recording'].includes(session.state);
    $('stop').textContent=session.state==='countdown'?'Отменить отсчёт':'Остановить';
    $('retake').disabled=busy||opening;
    $('share').disabled=sharing||busy||opening;
    $('results').hidden=!result;
    // Keep the previous file available, but prevent playback from bleeding into a take.
    $('playback').controls=!session.busy;
    $('results').inert=busy;
    if(validating)$('status').textContent='Проверяем готовый файл…';
    else if(session.state==='countdown')$('status').textContent='Приготовься. Запись начнётся после отсчёта.';
    else if(session.state==='starting')$('status').textContent='Запускаем запись…';
    else if(session.state==='recording')$('status').textContent='Идёт запись. Говори на выбранную тему.';
    else if(session.state==='finalizing')$('status').textContent='Завершаем запись. Подожди немного…';
    else if(opening)$('status').textContent='Разреши камеру и микрофон. Ждём первый кадр…';
    else if(cameraState==='ready')$('status').textContent='Проверь кадр и нажми «Начать запись».';
    else if(result)$('status').textContent='Камера выключена. Проверь и сохрани нужный ролик.';
    else $('status').textContent='Включи камеру и проверь положение в кадре.';
  }

  function renderStage(){
    if(!ctx)return;
    const w=canvas.width,h=canvas.height;
    ctx.fillStyle='#08080a';ctx.fillRect(0,0,w,h);
    const active=session.take?.settings||settings();
    if(source.readyState>=2&&source.videoWidth&&source.videoHeight&&cameraStream){
      const r=C.frameRect(source.videoWidth,source.videoHeight,w,h,active.framing);
      if(r){
        ctx.save();
        if(active.mirror){ctx.translate(w,0);ctx.scale(-1,1);}
        ctx.drawImage(source,r.x,r.y,r.width,r.height);
        ctx.restore();
      }
    }
    ctx.save();ctx.textAlign='center';ctx.textBaseline='alphabetic';
    ctx.fillStyle='#fff';ctx.shadowColor='rgba(0,0,0,.85)';ctx.shadowBlur=w*.015;ctx.shadowOffsetY=w*.003;
    const text=active.topic.toLocaleUpperCase('ru');
    let size=w*.075;
    do{ctx.font='700 '+size+'px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif';if(ctx.measureText(text).width<=w*.84)break;size-=2;}while(size>w*.032);
    ctx.fillText(text,w/2,h*.12,w*.84);
    ctx.font='500 '+Math.round(w*.045)+'px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif';
    ctx.fillText(C.formatTime(remaining),w/2,h*.166);
    ctx.restore();
  }
  function loop(){
    if(raf!==null||!cameraStream||document.hidden)return;
    raf=requestAnimationFrame(()=>{
      raf=null;
      try{renderStage();}catch(error){session.stop('track');setError(error);releaseCamera();return;}
      loop();
    });
  }
  function frameReady(video,requestId){
    return new Promise((resolve,reject)=>{
      const began=performance.now();let stableSince=began,lastSize='',finished=false,timer;
      const end=(error)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve();};
      const poll=()=>{
        if(requestId!==cameraRequest||document.hidden){end(new DOMException('Включение отменено','AbortError'));return;}
        if(performance.now()-began>10000){end(new Error('Камера не показала кадр. Закрой другие приложения камеры и попробуй снова.'));return;}
        const size=video.videoWidth+'x'+video.videoHeight;
        if(size!==lastSize){lastSize=size;stableSince=performance.now();}
        if(video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0&&performance.now()-stableSince>=250){end();return;}
        timer=setTimeout(poll,40);
      };
      poll();
    });
  }
  async function openCamera(){
    if(session.busy||validating||cameraState==='ready')return;
    if(!supports()){
      setError(new Error(!isSecureContext?'Для камеры нужна HTTPS-ссылка. Локальный HTML-файл не подходит.':'Этот браузер не поддерживает нужный способ записи. Открой ссылку в Safari на iPhone или Chrome на Android.'));
      return;
    }
    const requestId=++cameraRequest;
    cameraState='opening';notice('');updateUI();updateDebug();
    let acquired=null;
    try{
      const high=$('quality').value==='1080';
      // Landscape sensor ideals avoid assuming that portrait requests describe the
      // actual decoded frame on Safari. Geometry uses videoWidth/videoHeight only
      // after the first frames have stabilized; hardware testing is still required.
      const constraints={audio:{echoCancellation:true},video:{facingMode:{ideal:'user'},width:{ideal:high?1920:1280},height:{ideal:high?1080:720},frameRate:{ideal:30,max:30}}};
      try{acquired=await navigator.mediaDevices.getUserMedia(constraints);}
      catch(error){
        if(requestId!==cameraRequest)throw error;
        if(error.name!=='OverconstrainedError')throw error;
        acquired=await navigator.mediaDevices.getUserMedia({audio:true,video:{facingMode:{ideal:'user'}}});
      }
      if(requestId!==cameraRequest||document.hidden){acquired.getTracks().forEach(track=>track.stop());return;}
      cameraStream=acquired;source.srcObject=acquired;
      await source.play();await frameReady(source,requestId);
      if(requestId!==cameraRequest||document.hidden){acquired.getTracks().forEach(track=>track.stop());return;}
      if(!acquired.getAudioTracks().some(t=>t.readyState==='live'))throw new Error('Микрофон не включился. Для ролика нужен звук.');
      if(!acquired.getVideoTracks().some(t=>t.readyState==='live'))throw new Error('Камера отключилась до появления кадра. Попробуй включить её снова.');
      const size=C.outputSize($('quality').value,source.videoWidth,source.videoHeight);
      canvas.width=size.width;canvas.height=size.height;
      const v=acquired.getVideoTracks()[0],a=acquired.getAudioTracks()[0];
      cameraInfo={decoded:source.videoWidth+'×'+source.videoHeight,video:v.getSettings?.()||{},audio:a.getSettings?.()||{},canvas:size.width+'×'+size.height};
      acquired.getTracks().forEach(track=>track.addEventListener('ended',()=>{
        if(cameraStream!==acquired)return;
        session.stop('track');releaseCamera();notice('Камера или микрофон отключились. Если запись шла, проверь сохранившийся фрагмент.');updateUI();
      },{once:true}));
      cameraState='ready';$('empty').hidden=true;
      remaining=C.duration($('duration').value);$('timer').textContent=C.formatTime(remaining);
      updateFrameNote();renderStage();loop();updateUI();updateDebug();
    }catch(error){
      acquired?.getTracks().forEach(track=>track.stop());
      if(requestId!==cameraRequest)return;
      releaseCamera();setError(new Error(C.cameraError(error)));updateUI();
    }
  }
  function releaseCamera(){
    ++cameraRequest;
    const old=cameraStream;cameraStream=null;cameraState='off';
    if(raf!==null)cancelAnimationFrame(raf);raf=null;
    old?.getTracks().forEach(track=>{try{track.stop();}catch(_){}});
    source.pause();source.srcObject=null;
    // Do not clear the canvas here: preserve the final visible frame after stop.
    updateDebug();
  }
  function updateFrameNote(){
    if(!cameraStream)return;
    let text=$('framing').value==='contain'?'Сохраняется весь кадр камеры.':'Края кадра обрезаются до 9:16.';
    if($('quality').value==='1080'&&canvas.width<1080)text+=' Камера не выдала вертикальные 1080×1920: для этой попытки используется 720p.';
    $('frameNote').textContent=text;
  }

  async function requestWakeLock(){
    const generation=++wakeGeneration;
    if(!navigator.wakeLock?.request||document.hidden)return;
    try{
      const lock=await navigator.wakeLock.request('screen');
      if(generation!==wakeGeneration||!session.busy||document.hidden){await lock.release();return;}
      wakeLock=lock;lock.addEventListener('release',()=>{if(wakeLock===lock)wakeLock=null;});
    }catch(_){/* Optional capability: no substitute audio or video is played. */}
  }
  function releaseWakeLock(){
    ++wakeGeneration;const lock=wakeLock;wakeLock=null;
    if(lock)void lock.release().catch(()=>{});
  }
  function probeVideo(url){
    return new Promise((resolve,reject)=>{
      const probe=document.createElement('video');let done=false;
      const timer=setTimeout(()=>finish(new Error('Браузер не подтвердил воспроизведение файла.')),10000);
      const finish=error=>{
        if(done)return;done=true;clearTimeout(timer);
        const info={width:probe.videoWidth,height:probe.videoHeight,duration:Number.isFinite(probe.duration)?probe.duration:null};
        probe.onloadedmetadata=probe.onerror=null;probe.removeAttribute('src');probe.load();
        error?reject(error):resolve(info);
      };
      probe.preload='metadata';probe.muted=true;probe.playsInline=true;
      probe.onloadedmetadata=()=>{probe.videoWidth&&probe.videoHeight?finish():finish(new Error('У файла нет доступной видеодорожки.'));};
      probe.onerror=()=>finish(new Error('Этот браузер не смог воспроизвести полученный файл.'));
      probe.src=url;probe.load();
    });
  }
  async function receiveResult(take){
    validating=true;releaseCamera();releaseWakeLock();updateUI();
    const candidate={...take,url:URL.createObjectURL(take.blob),info:null};
    const ext=C.fileExtension(take.type);
    candidate.filename='govori-'+new Date().toISOString().replace(/[:.]/g,'-')+'.'+ext;
    latestStop=take.reason;
    try{
      candidate.info=await probeVideo(candidate.url);
      const ratio=candidate.info.width/candidate.info.height;
      if(Math.abs(ratio-9/16)>.015)candidate.warning=(candidate.warning?candidate.warning+' ':'')+'Браузер создал файл с другими пропорциями. Проверь ориентацию видео на телефоне.';
    }catch(error){
      candidate.warning=(candidate.warning?candidate.warning+' ':'')+error.message+' Можно скачать его и проверить проигрывателем телефона.';
      candidate.unverified=true;lastError=error.message;
    }
    if(candidate.unverified&&result){
      if(recovery)URL.revokeObjectURL(recovery.url);
      recovery=candidate;$('recoverySave').href=candidate.url;$('recoverySave').download=candidate.filename;$('recovery').hidden=false;
      notice(candidate.warning+' Предыдущий готовый ролик оставлен на странице.');
    }else{
      const previous=result;result=candidate;
      $('playback').src=result.url;$('playback').load();
      $('save').href=result.url;$('save').download=result.filename;$('openVideo').href=result.url;
      if(previous)URL.revokeObjectURL(previous.url);
      if(recovery)URL.revokeObjectURL(recovery.url);recovery=null;$('recovery').hidden=true;
      fileInfo={type:result.type||'не определён',bytes:result.blob.size,requested:result.settings.width+'×'+result.settings.height,decoded:result.info?result.info.width+'×'+result.info.height:'не проверено',metadataDuration:result.info?.duration??'не определена',measuredSeconds:Math.round(result.elapsedMs/100)/10};
      const seconds=Math.round(result.elapsedMs/100)/10;
      $('resultNote').textContent=result.settings.topic+' · '+seconds+' с · '+(result.blob.size/1048576).toFixed(1)+' МБ · '+(ext==='bin'?'формат не определён':ext.toUpperCase());
      let shareable=false;
      try{
        result.file=new File([result.blob],result.filename,{type:(result.type||result.blob.type).split(';')[0]});
        shareable=Boolean(navigator.share&&navigator.canShare?.({files:[result.file]}));
      }catch(_){}
      $('share').hidden=!shareable;
      $('saveHelp').textContent=shareable?'Кнопка меню открывает системные варианты сохранения. Выбери нужное действие сам. «Скачать файл» доступно отдельно.':'Нажми «Скачать файл». Если открылся просмотр, используй меню телефона для сохранения в Фото или Файлы. Также можно открыть видео отдельно.';
      $('exportStatus').textContent='';notice(result.warning);
    }
    validating=false;remaining=C.remaining(take.settings.duration,take.elapsedMs);$('timer').textContent=C.formatTime(remaining);updateUI();updateDebug();
    $('results').scrollIntoView({block:'start',behavior:'auto'});
  }
  async function shareResult(){
    if(!result?.file||session.busy||validating||sharing)return;
    const file=result.file;sharing=true;updateUI();
    $('exportStatus').textContent='Открывается меню телефона. Выбери, куда сохранить файл.';
    try{
      await navigator.share({files:[file]});
      $('exportStatus').textContent='Меню закрыто. Проверь, что видео появилось там, куда ты его сохраняла.';
    }catch(error){
      $('exportStatus').textContent=error.name==='AbortError'?'Действие отменено. Ролик остался на странице.':'Не удалось открыть меню. Используй «Скачать файл» или «Открыть видео отдельно».';
    }finally{sharing=false;updateUI();}
  }
  function updateDebug(){
    const cleanTrack=track=>{
      if(!track)return null;
      const out={};for(const key of ['width','height','aspectRatio','frameRate','facingMode','sampleRate','channelCount','echoCancellation'])if(track[key]!==undefined)out[key]=track[key];return out;
    };
    $('debugText').textContent=JSON.stringify({version:VERSION,browser:navigator.userAgent,secure:isSecureContext,features:{camera:Boolean(navigator.mediaDevices?.getUserMedia),recorder:Boolean(globalThis.MediaRecorder),canvasRecording:typeof canvas.captureStream==='function',fileShare:Boolean(navigator.share&&navigator.canShare)},state:validating?'validating':session.state,cameraState,camera:cameraInfo?{decoded:cameraInfo.decoded,video:cleanTrack(cameraInfo.video),audio:cleanTrack(cameraInfo.audio),canvas:cameraInfo.canvas}:null,framing:$('framing').value,mirror:$('mirror').checked,recordingMime:session.take?.recorder?.mimeType||null,file:fileInfo,stopReason:latestStop||null,lastError:lastError||null},null,2);
  }

  $('camera').addEventListener('click',()=>{
    if(cameraState==='ready'||cameraState==='opening'){releaseCamera();updateUI();}else void openCamera();
  });
  $('record').addEventListener('click',()=>{
    if(validating||cameraState!=='ready'||session.busy)return;
    remaining=C.duration($('duration').value);
    session.start(cameraStream,settings());
  });
  $('stop').addEventListener('click',()=>session.stop('manual'));
  $('retake').addEventListener('click',async()=>{
    if(session.busy||validating)return;
    $('playback').pause();await openCamera();$('screen').scrollIntoView({block:'center',behavior:'auto'});
  });
  $('next').addEventListener('click',()=>{
    if(session.busy)return;
    if(!wordBag.length)wordBag=globalThis.GovoriWords.filter(word=>word.toLocaleLowerCase('ru')!==topic.toLocaleLowerCase('ru'));
    const index=Math.floor(Math.random()*wordBag.length),word=wordBag.splice(index,1)[0];
    topic=word[0].toLocaleUpperCase('ru')+word.slice(1);$('topic').textContent=topic;renderStage();
  });
  $('duration').addEventListener('change',()=>{remaining=C.duration($('duration').value);$('timer').textContent=C.formatTime(remaining);renderStage();});
  for(const id of ['framing','mirror'])$(id).addEventListener('change',()=>{updateFrameNote();renderStage();updateDebug();});
  $('quality').addEventListener('change',()=>{
    if(cameraStream){releaseCamera();notice('Включи камеру снова, чтобы применить выбранный размер.');updateUI();}
    updateDebug();
  });
  $('share').addEventListener('click',()=>{void shareResult();});
  $('save').addEventListener('click',()=>{$('exportStatus').textContent='Браузер получил запрос на скачивание. Проверь сохранённый файл на телефоне.';});
  $('playback').addEventListener('play',()=>{
    if(session.busy){$('playback').pause();return;}
    if(cameraStream||cameraState==='opening'){releaseCamera();updateUI();}
  });
  $('playback').addEventListener('error',()=>{
    if(result&&!validating)notice('Встроенный просмотр не смог открыть запись. Скачай файл и проверь его проигрывателем телефона.');
  });
  $('copyDebug').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText($('debugText').textContent);$('copyStatus').textContent='Скопировано. Данные содержат версию браузера, но не запись.';}
    catch(_){$('copyStatus').textContent='Копирование недоступно. Можно выделить текст выше или сделать снимок экрана.';}
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){
      if(session.busy){session.stop('hidden');notice('Запись прервана сворачиванием. По возвращении проверь результат.');}
      releaseCamera();releaseWakeLock();updateUI();
    }else{sharing=false;updateUI();updateDebug();}
  });
  const orientationChanged=()=>{
    if(session.busy){session.stop('orientation');notice('Положение телефона изменилось. Проверь получившийся фрагмент.');}
  };
  if(screen.orientation?.addEventListener)screen.orientation.addEventListener('change',orientationChanged);
  else window.addEventListener('orientationchange',orientationChanged);
  window.addEventListener('pagehide',()=>{
    // Best effort only: saving during an actual page close is not guaranteed.
    session.dispose();releaseCamera();releaseWakeLock();
  });
  window.addEventListener('pageshow',()=>{updateUI();updateDebug();});
  window.addEventListener('beforeunload',event=>{
    if(session.busy||validating||result||recovery){event.preventDefault();event.returnValue='';}
  });
  updateUI();updateDebug();renderStage();
  if(!supports())notice(!isSecureContext?'Камера работает по HTTPS. Сначала размести эту сборку на тестовом сайте.':'В этом браузере нужный способ записи может быть недоступен. Для теста используй Safari на iPhone или Chrome на Android.');
})();
