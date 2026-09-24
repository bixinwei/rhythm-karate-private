import {loadTimingRenderer} from './heaven-timing-runtime.js';
try {
  window.HeavenTiming=await loadTimingRenderer();
  const script=document.createElement('script');
  script.src=new URL('./game.js?v=heaven-source-particles-61',import.meta.url).href;
  document.body.append(script);
} catch(error) {
  console.error(error);
  const message=document.createElement('p');message.textContent='特效资源加载失败，请刷新重试。';document.body.append(message);
}
