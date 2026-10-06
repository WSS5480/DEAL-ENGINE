/* pull-to-refresh: a home-screen app has no browser bar, so no built-in pull-down */
(function(){
  if(window.__ptr) return; window.__ptr=1;
  var y0=null, d=0, on=false, el=null, TH=70;
  function bar(){
    if(el) return el;
    el=document.createElement("div");
    el.setAttribute("aria-hidden","true");
    el.style.cssText="position:fixed;left:50%;top:0;z-index:99999;width:38px;height:38px;margin-left:-19px;"+
      "border-radius:50%;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.18);display:flex;align-items:center;"+
      "justify-content:center;font:20px/1 system-ui;color:#0B4FD3;transform:translateY(-50px);opacity:0;pointer-events:none";
    el.textContent="↻"; document.body.appendChild(el); return el;
  }
  function busy(t){ return t&&t.closest&&t.closest("input,textarea,select,[contenteditable],.noptr") }
  addEventListener("touchstart",function(e){
    if(window.scrollY>0||e.touches.length!==1||busy(e.target)){ y0=null; return }
    y0=e.touches[0].clientY; d=0; on=false;
  },{passive:true});
  addEventListener("touchmove",function(e){
    if(y0===null) return;
    d=e.touches[0].clientY-y0;
    if(d<=0||window.scrollY>0){ if(el){el.style.opacity=0;el.style.transform="translateY(-50px)"} return }
    on=true; var b=bar(), p=Math.min(1,d/TH);
    b.style.transition="none"; b.style.opacity=String(p);
    b.style.transform="translateY("+(Math.min(d,TH*1.4)*0.7-40)+"px) rotate("+(p*270)+"deg)";
    b.style.color=p>=1?"#12785a":"#0B4FD3";
  },{passive:true});
  addEventListener("touchend",function(){
    if(y0===null||!on){ y0=null; return }
    var b=bar(); y0=null;
    if(d>=TH){
      b.style.transition="transform .2s"; b.style.transform="translateY(20px)";
      b.animate&&b.animate([{rotate:"0deg"},{rotate:"360deg"}],{duration:700,iterations:Infinity});
      setTimeout(function(){ (window.ptrRefresh||function(){location.reload()})() },120);
    }else{ b.style.transition="transform .2s,opacity .2s"; b.style.transform="translateY(-50px)"; b.style.opacity=0 }
  });
})();
