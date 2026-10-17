/* Shared, platform-independent rules. No camera, storage or network side effects. */
(function(root){
  'use strict';
  const DURATIONS=Object.freeze([10,30,60,90,120]);
  const MIME_TYPES=Object.freeze(['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm']);
  function duration(value){const n=Number(value);return DURATIONS.includes(n)?n:60;}
  function remaining(total,elapsedMs){return Math.max(0,Math.ceil(total-Math.max(0,elapsedMs)/1000));}
  function formatTime(seconds){const s=Math.max(0,Math.ceil(Number(seconds)||0));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
  function frameRect(vw,vh,w,h,mode){if(![vw,vh,w,h].every(n=>Number.isFinite(n)&&n>0))return null;const scale=mode==='cover'?Math.max(w/vw,h/vh):Math.min(w/vw,h/vh);return{x:(w-vw*scale)/2,y:(h-vh*scale)/2,width:vw*scale,height:vh*scale};}
  function outputSize(quality,vw,vh){return String(quality)==='1080'&&vw>=1080&&vh>=1920?{width:1080,height:1920}:{width:720,height:1280};}
  function mimeCandidates(Recorder){if(!Recorder)return[];if(typeof Recorder.isTypeSupported!=='function')return[''];return MIME_TYPES.filter(type=>{try{return Recorder.isTypeSupported(type);}catch(_){return false;}}).concat('');}
  function fileExtension(type){const t=(type||'').toLowerCase();if(t.startsWith('video/mp4'))return'mp4';if(t.startsWith('video/webm'))return'webm';if(t.startsWith('video/ogg'))return'ogv';return'bin';}
  function cameraError(error){const m={NotAllowedError:'Разреши доступ к камере и микрофону в настройках браузера, затем попробуй снова.',NotFoundError:'Не найдены камера или микрофон. Проверь подключение и разрешения.',NotReadableError:'Камера или микрофон сейчас недоступны. Закрой другие приложения, которые могут их использовать.',OverconstrainedError:'Камера не поддерживает выбранные параметры. Попробуй размер 720p.',SecurityError:'Браузер заблокировал доступ. Открой HTTPS-ссылку в Safari на iPhone или Chrome на Android.',AbortError:'Подключение камеры прервалось. Попробуй включить её снова.'};return m[error?.name]||('Не удалось включить камеру. '+(error?.message||'Попробуй открыть ссылку в Safari или Chrome.'));}
  root.GovoriCore=Object.freeze({DURATIONS,MIME_TYPES,duration,remaining,formatTime,frameRect,outputSize,mimeCandidates,fileExtension,cameraError});
})(globalThis);
