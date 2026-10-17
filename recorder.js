/* Canvas + microphone recording, adapted from the original prototype.
 * Each take owns its recorder, audio clones, chunks and timers.
 * Browser dependencies are injectable for deterministic lifecycle tests.
 */
(function(root){
  'use strict';
  const C=root.GovoriCore;
  class CaptureSession {
    constructor(options){
      this.canvas=options.canvas;
      this.Recorder=options.Recorder||root.MediaRecorder;
      this.Stream=options.Stream||root.MediaStream;
      this.Blob=options.Blob||root.Blob;
      this.now=options.now||(()=>performance.now());
      this.setInterval=options.setInterval||root.setInterval.bind(root);
      this.clearInterval=options.clearInterval||root.clearInterval.bind(root);
      this.setTimeout=options.setTimeout||root.setTimeout.bind(root);
      this.clearTimeout=options.clearTimeout||root.clearTimeout.bind(root);
      this.onState=options.onState||(()=>{});
      this.onTick=options.onTick||(()=>{});
      this.onResult=options.onResult||(()=>{});
      this.onError=options.onError||(()=>{});
      this.beforeStart=options.beforeStart||(()=>{});
      this.state='idle';
      this.take=null;
    }
    get busy(){return this.state!=='idle';}
    change(state){this.state=state;this.onState(state,this.take);}
    start(stream,settings){
      if(this.busy)return false;
      if(!this.Recorder||!this.Stream||typeof this.canvas.captureStream!=='function'){
        this.onError(new Error('Этот браузер не поддерживает запись с надписями. Открой ссылку в Safari на iPhone или Chrome на Android.'));
        return false;
      }
      const audio=stream?.getAudioTracks().filter(t=>t.readyState==='live')||[];
      const video=stream?.getVideoTracks().filter(t=>t.readyState==='live')||[];
      if(!audio.length||!video.length){this.onError(new Error('Камера или микрофон выключены. Включи их перед записью.'));return false;}
      const t={settings:Object.freeze({...settings,duration:C.duration(settings.duration)}),source:stream,
        countdownAt:this.now(),startedAt:null,elapsedMs:0,chunks:[],bytes:0,recorder:null,
        ownedTracks:[],interval:null,guard:null,finished:false,warning:'',reason:'',remaining:C.duration(settings.duration)};
      this.take=t;
      this.change('countdown');
      this.onTick({countdown:3,remaining:t.remaining,elapsedMs:0});
      t.interval=this.setInterval(()=>this.tick(t),50);
      return true;
    }
    tick(t){
      if(this.take!==t||t.finished)return;
      if(this.state==='countdown'){
        const count=Math.max(0,Math.ceil((3000-(this.now()-t.countdownAt))/1000));
        if(!count){this.begin(t);return;}
        this.onTick({countdown:count,remaining:t.settings.duration,elapsedMs:0});
      }else if(this.state==='recording'){
        t.elapsedMs=Math.max(0,this.now()-t.startedAt);
        t.remaining=C.remaining(t.settings.duration,t.elapsedMs);
        this.onTick({countdown:0,remaining:t.remaining,elapsedMs:t.elapsedMs});
        if(t.elapsedMs>=t.settings.duration*1000)this.stop('timer');
      }
    }
    begin(t){
      if(this.take!==t||this.state!=='countdown')return;
      this.change('starting');
      this.onTick({countdown:0,remaining:t.settings.duration,elapsedMs:0});
      try{
        const originalAudio=t.source.getAudioTracks().filter(track=>track.readyState==='live');
        if(!originalAudio.length||!t.source.getVideoTracks().some(track=>track.readyState==='live'))throw new Error('Доступ к камере или микрофону прервался до старта.');
        this.beforeStart(t);
        const capture=this.canvas.captureStream(30);
        t.ownedTracks.push(...capture.getTracks());
        const video=capture.getVideoTracks();
        if(!video.length)throw new Error('Браузер не создал видеопоток с надписями.');
        const audio=originalAudio.map(track=>{
          const copy=track.clone();t.ownedTracks.push(copy);return copy;
        });
        const composed=new this.Stream([...video,...audio]);
        let lastError;
        for(const mimeType of C.mimeCandidates(this.Recorder)){
          let recorder;
          try{
            const options=mimeType?{mimeType,videoBitsPerSecond:this.canvas.width>=1080?6000000:3500000,audioBitsPerSecond:128000}:undefined;
            recorder=new this.Recorder(composed,options);
            t.recorder=recorder;
            recorder.ondataavailable=event=>{
              if(t.finished||!event.data?.size)return;
              t.chunks.push(event.data);t.bytes+=event.data.size;
              if(t.bytes>96*1024*1024&&this.state==='recording')this.stop('size');
            };
            recorder.onstart=()=>{
              if(this.take!==t||t.finished||this.state!=='starting')return;
              this.clearTimeout(t.guard);t.guard=null;
              t.startedAt=this.now();
              this.change('recording');
              this.onTick({countdown:0,remaining:t.settings.duration,elapsedMs:0});
            };
            recorder.onerror=event=>{
              if(this.take!==t||t.finished)return;
              t.warning='Запись прервалась: '+(event.error?.message||'ошибка браузера')+'. Проверь сохранившийся фрагмент.';
              this.stop('error');
            };
            recorder.onstop=()=>this.finish(t);
            // Set guard before start: even a synchronous test implementation is supported.
            t.guard=this.setTimeout(()=>this.fail(t,new Error('Браузер не подтвердил начало записи. Попробуй 720p и включи камеру снова.')),8000);
            recorder.start(1000);
            return;
          }catch(error){
            lastError=error;
            this.clearTimeout(t.guard);t.guard=null;
            if(recorder){
              recorder.onstart=recorder.ondataavailable=recorder.onerror=recorder.onstop=null;
              try{if(recorder.state!=='inactive')recorder.stop();}catch(_){}
            }
          }
        }
        throw lastError||new Error('Не найден формат видеозаписи.');
      }catch(error){this.fail(t,error);}
    }
    stop(reason='manual'){
      const t=this.take;
      if(!t||t.finished||this.state==='idle'||this.state==='finalizing')return;
      t.reason=reason;
      if(this.state==='countdown'){
        this.cleanup(t);t.finished=true;this.take=null;this.change('idle');return;
      }
      if(t.startedAt!==null)t.elapsedMs=Math.max(0,this.now()-t.startedAt);
      t.remaining=C.remaining(t.settings.duration,t.elapsedMs);
      if(reason==='hidden')t.warning='Запись завершена досрочно: приложение было свёрнуто. Проверь звук и видео перед сохранением.';
      if(reason==='orientation')t.warning='Запись завершена досрочно: положение телефона изменилось. Проверь получившийся фрагмент.';
      if(reason==='track')t.warning='Камера или микрофон отключились. Проверь сохранившийся фрагмент.';
      if(reason==='size')t.warning='Запись завершена раньше, чтобы ограничить размер файла. Сохрани фрагмент и попробуй 720p.';
      this.clearInterval(t.interval);t.interval=null;
      this.clearTimeout(t.guard);
      this.change('finalizing');
      this.onTick({countdown:0,remaining:t.remaining,elapsedMs:t.elapsedMs});
      t.guard=this.setTimeout(()=>this.fail(t,new Error('Браузер не завершил обработку записи. Предыдущий готовый ролик, если он был, сохранён на странице. Попробуй короткую запись в 720p.')),15000);
      try{
        if(t.recorder&&t.recorder.state!=='inactive')t.recorder.stop();
        // Inactive recorders may still be dispatching final dataavailable/onstop.
        // Never build a Blob here: wait for the terminal event, or the guard.
      }catch(error){this.fail(t,error);}
    }
    finish(t){
      if(this.take!==t||t.finished)return;
      if(t.startedAt!==null&&this.state!=='finalizing')t.elapsedMs=Math.max(0,this.now()-t.startedAt);
      let result,error;
      try{
        if(!t.chunks.length)throw new Error('Браузер не создал файл. Попробуй короткую запись в 720p.');
        const type=t.recorder?.mimeType||t.chunks.find(chunk=>chunk.type)?.type||'';
        const blob=new this.Blob(t.chunks,{type});
        if(!blob.size)throw new Error('Получен пустой файл. Попробуй включить камеру снова.');
        result={blob,type,settings:t.settings,elapsedMs:t.elapsedMs,reason:t.reason||'browser',warning:t.warning};
      }catch(e){error=e;}
      this.cleanup(t);t.finished=true;this.take=null;
      // Do not expose idle until the result/error is delivered: app validation may start.
      this.state='idle';
      if(error)this.onError(error);else this.onResult(result);
      this.onState('idle',null);
    }
    fail(t,error){
      if(this.take!==t||t.finished)return;
      t.finished=true;
      if(t.recorder){
        t.recorder.onstart=t.recorder.ondataavailable=t.recorder.onerror=t.recorder.onstop=null;
        try{if(t.recorder.state!=='inactive')t.recorder.stop();}catch(_){}
      }
      this.cleanup(t);this.take=null;this.state='idle';this.onError(error);this.onState('idle',null);
    }
    cleanup(t){
      this.clearInterval(t.interval);this.clearTimeout(t.guard);
      t.interval=t.guard=null;
      t.ownedTracks.forEach(track=>{try{track.stop();}catch(_){}});
      t.ownedTracks=[];
    }
    dispose(){
      const t=this.take;
      if(!t)return;
      t.finished=true;
      if(t.recorder){
        t.recorder.onstart=t.recorder.ondataavailable=t.recorder.onerror=t.recorder.onstop=null;
        try{if(t.recorder.state!=='inactive')t.recorder.stop();}catch(_){}
      }
      this.cleanup(t);this.take=null;this.state='idle';
    }
  }
  root.GovoriCapture=CaptureSession;
})(globalThis);
