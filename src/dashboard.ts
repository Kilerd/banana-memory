export const dashboardHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Banana Memory</title>
  <style>
    :root{color-scheme:light;--ink:#171810;--muted:#707263;--paper:#f4f2e9;--card:#fffef9;--line:#ddd9ca;--yellow:#f6c945;--green:#38664a;--red:#9d493f;--blue:#3e6071;--shadow:0 18px 50px rgba(48,42,24,.08)}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.35;background-image:radial-gradient(#c8c3b1 .55px,transparent .55px);background-size:8px 8px}
    button,input,select{font:inherit}button{cursor:pointer}.shell{position:relative;display:grid;grid-template-columns:255px minmax(0,1fr);min-height:100vh}
    aside{padding:28px 20px;border-right:1px solid var(--line);background:rgba(249,248,241,.84);backdrop-filter:blur(12px)}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:34px}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:var(--yellow);font-size:23px;box-shadow:inset 0 -2px 0 rgba(0,0,0,.08)}
    .brand strong{display:block;font-size:16px;letter-spacing:-.02em}.brand small,.quiet{color:var(--muted)}
    .nav-title{margin:22px 8px 8px;color:#929383;font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.project-nav{width:100%;display:flex;gap:10px;align-items:center;padding:10px;border:0;border-radius:12px;background:transparent;text-align:left;color:var(--ink)}
    .project-nav:hover,.project-nav.on{background:#ebe7d8}.project-nav .dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(56,102,74,.1)}.project-nav.paused .dot{background:var(--red)}
    .project-nav span{min-width:0}.project-nav b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.project-nav small{color:var(--muted)}
    main{padding:34px clamp(24px,5vw,72px) 70px;min-width:0}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}.eyebrow{color:var(--green);font-size:12px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}
    h1{font-family:Georgia,"Songti SC",serif;font-size:clamp(32px,4vw,52px);font-weight:500;letter-spacing:-.045em;line-height:1.08;margin:6px 0 8px}.model{display:flex;align-items:center;gap:8px;margin-top:10px;color:var(--muted)}.model i{width:8px;height:8px;border-radius:50%;background:var(--green)}
    .refresh{border:1px solid var(--line);background:var(--card);padding:10px 14px;border-radius:11px;box-shadow:0 4px 16px rgba(48,42,24,.04)}
    .stats{display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:12px;margin:30px 0}.stat{padding:17px 18px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}.stat b{display:block;font:500 28px/1 Georgia,serif}.stat span{color:var(--muted);font-size:12px}
    .toolbar{display:grid;grid-template-columns:minmax(220px,1fr) repeat(3,150px);gap:10px;margin:0 0 18px}.toolbar input,.toolbar select{width:100%;border:1px solid var(--line);border-radius:11px;background:rgba(255,254,249,.85);padding:10px 12px;color:var(--ink);outline:none}.toolbar input:focus,.toolbar select:focus{border-color:#8d8a77;box-shadow:0 0 0 3px rgba(141,138,119,.12)}
    .result-line{display:flex;justify-content:space-between;color:var(--muted);margin:0 2px 10px}.memory-grid{display:grid;gap:12px}.memory{display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:20px;padding:20px;background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:0 7px 24px rgba(48,42,24,.045);transition:.15s ease}.memory:hover{transform:translateY(-1px);border-color:#c8c2ad}
    .badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}.badge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:#eeece2;color:#5f6055;font-size:11px;font-weight:750}.badge.global{background:#dce9ec;color:#294f5d}.badge.active{background:#dfecdf;color:#315b3e}.badge.candidate{background:#fff0bf;color:#745b0d}.badge.review{background:#f4dcd6;color:#7f3c33}.badge.archived,.badge.superseded{background:#e4e2dc;color:#66675f}
    .memory h2{font-size:16px;line-height:1.55;margin:0 0 11px;font-weight:650;white-space:pre-wrap}.meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px}.reason{margin:13px 0 0;padding-left:11px;border-left:2px solid var(--yellow);color:#57594d}
    .decay{align-self:stretch;border-left:1px solid var(--line);padding-left:20px}.decay-head{display:flex;justify-content:space-between;align-items:baseline}.decay-head b{font:500 24px/1 Georgia,serif}.bar{height:7px;margin:12px 0 8px;border-radius:99px;background:#ebe8dc;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--yellow),#d7a91f);border-radius:inherit}.decay p{margin:0;color:var(--muted);font-size:12px}.open{margin-top:14px;border:0;background:transparent;color:var(--green);font-weight:750;padding:0}
    .empty,.error{padding:60px 20px;text-align:center;border:1px dashed #c9c4b3;border-radius:18px;color:var(--muted)}.error{color:var(--red)}.more{display:block;margin:18px auto 0;padding:10px 18px;border:1px solid var(--line);border-radius:11px;background:var(--card)}.more[hidden]{display:none}
    dialog{width:min(760px,calc(100vw - 30px));max-height:88vh;padding:0;border:1px solid var(--line);border-radius:22px;background:var(--card);color:var(--ink);box-shadow:0 30px 100px rgba(31,28,18,.3)}dialog::backdrop{background:rgba(31,29,21,.48);backdrop-filter:blur(3px)}
    .dialog-head{position:sticky;top:0;display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:23px 26px 18px;background:rgba(255,254,249,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);z-index:1}.dialog-head h2{margin:0;font:500 24px/1.3 Georgia,"Songti SC",serif}.close{border:0;background:#ece9dd;border-radius:50%;width:34px;height:34px;font-size:20px}.dialog-body{padding:22px 26px 32px}.section{margin:0 0 25px}.section h3{font-size:11px;text-transform:uppercase;letter-spacing:.13em;color:var(--muted);margin:0 0 10px}.section p{white-space:pre-wrap}.source,.history{padding:12px 14px;margin:8px 0;background:#f5f2e8;border-radius:11px}.source small,.history small{display:block;color:var(--muted);margin-bottom:5px}.chips{display:flex;gap:6px;flex-wrap:wrap}.mono{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:#595b51}.lineage{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.lineage div{background:#f5f2e8;border-radius:11px;padding:12px}.lineage b{display:block;font:500 22px/1 Georgia,serif}.lineage span{font-size:11px;color:var(--muted)}
    @media(max-width:900px){.shell{grid-template-columns:1fr}aside{position:static;border-right:0;border-bottom:1px solid var(--line);padding:18px 20px}.brand{margin-bottom:10px}.nav-title{display:none}#projects{display:flex;overflow:auto;gap:4px}.project-nav{min-width:170px}.stats{grid-template-columns:repeat(3,1fr)}.toolbar{grid-template-columns:1fr 1fr}.toolbar input{grid-column:1/-1}}
    @media(max-width:620px){main{padding:25px 16px 50px}.stats{grid-template-columns:1fr 1fr}.stat:last-child{grid-column:1/-1}.toolbar{grid-template-columns:1fr}.toolbar input{grid-column:auto}.memory{grid-template-columns:1fr}.decay{border-left:0;border-top:1px solid var(--line);padding:15px 0 0}.top{align-items:center}.lineage{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="shell">
  <aside><div class="brand"><div class="mark">🍌</div><div><strong>Banana Memory</strong><small>本地记忆控制台</small></div></div><div class="nav-title">项目</div><div id="projects"></div></aside>
  <main>
    <div class="top"><div><div class="eyebrow">Memory Observatory</div><h1>记忆如何留下，<br>又如何变化。</h1><div class="model"><i></i><span id="model">正在连接本地服务…</span></div></div><button class="refresh" id="refresh">刷新</button></div>
    <div class="stats" id="stats"></div>
    <div class="toolbar"><input id="search" type="search" placeholder="搜索记忆、条件或原因"><select id="scope"><option value="">全部作用域</option><option value="project">当前项目</option><option value="global">跨项目</option></select><select id="state"><option value="">全部状态</option><option value="active">生效</option><option value="candidate">候选</option><option value="review">待复核</option><option value="archived">已归档</option><option value="superseded">已替代</option></select><select id="type"><option value="">全部类型</option><option value="fact">事实</option><option value="preference">偏好</option><option value="episode">经历</option><option value="experience">合并经验</option></select></div>
    <div class="result-line"><span id="result"></span><span id="updated"></span></div><div class="memory-grid" id="memories"></div><button class="more" id="more" hidden>再显示 100 条</button>
  </main>
</div>
<dialog id="detail"><div class="dialog-head"><h2 id="detail-title"></h2><button class="close" aria-label="关闭">×</button></div><div class="dialog-body" id="detail-body"></div></dialog>
<script>
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {active:'生效',candidate:'候选',review:'待复核',archived:'已归档',superseded:'已替代',project:'项目内',global:'跨项目',fact:'事实',preference:'偏好',episode:'经历',experience:'合并经验'};
  const decayLabels = {none:'稳定',expired:'已过有效期',environment_mismatch:'环境不再匹配',temporary_stale:'临时记忆超过 7 天',episode_stale:'经历超过 180 天'};
  let data = null, selectedProject = '', visibleLimit = 100;
  const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
  if (hashToken) { sessionStorage.setItem('banana-memory-token', hashToken); history.replaceState(null, '', location.pathname + location.search); }
  const token = sessionStorage.getItem('banana-memory-token') || '';
  const fmt = value => value ? new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '—';
  function projectList() {
    $('projects').innerHTML = '<button class="project-nav '+(!selectedProject?'on':'')+'" data-project=""><span class="dot"></span><span><b>全部项目</b><small>'+data.totals.memories+' 条记忆</small></span></button>' + data.projects.map(p => '<button class="project-nav '+(p.paused?'paused ':'')+(selectedProject===p.id?'on':'')+'" data-project="'+esc(p.id)+'"><span class="dot"></span><span><b>'+esc(p.name)+'</b><small>'+p.counts.memories+' 条 · '+p.counts.global+' 条跨项目</small></span></button>').join('');
    document.querySelectorAll('[data-project]').forEach(el => el.onclick = () => { selectedProject = el.dataset.project; visibleLimit=100; projectList(); render(); });
  }
  function stats() {
    const items = [['记忆',data.totals.memories],['生效',data.totals.active],['候选',data.totals.candidates],['跨项目',data.totals.global],['合并经验',data.totals.derived]];
    $('stats').innerHTML = items.map(x => '<div class="stat"><b>'+x[1]+'</b><span>'+x[0]+'</span></div>').join('');
  }
  function filtered() {
    const q = $('search').value.trim().toLowerCase(), scope = $('scope').value, state = $('state').value, type = $('type').value;
    return data.memories.filter(m => (!selectedProject || m.projectId===selectedProject) && (!scope || m.scope===scope) && (!state || m.effectiveState===state) && (!type || m.type===type) && (!q || [m.text,m.reason,m.projectName,(m.conditions||[]).join(' ')].join(' ').toLowerCase().includes(q)));
  }
  function render() {
    if (!data) return;
    const rows = filtered(), shown = rows.slice(0,visibleLimit); $('result').textContent = '显示 '+shown.length+' / '+rows.length+' 条（共 '+data.memories.length+' 条）';
    $('more').hidden=shown.length===rows.length;
    if (!rows.length) { $('memories').innerHTML = '<div class="empty">没有符合筛选条件的记忆</div>'; return; }
    $('memories').innerHTML = shown.map(m => {
      const percent = Math.max(0,Math.min(100,Math.round(m.decay.weight*100)));
      return '<article class="memory"><div><div class="badges"><span class="badge '+esc(m.effectiveState)+'">'+esc(labels[m.effectiveState]||m.effectiveState)+'</span><span class="badge '+esc(m.scope)+'">'+esc(labels[m.scope])+'</span><span class="badge">'+esc(labels[m.type]||m.type)+'</span>'+(m.pinned?'<span class="badge">已固定</span>':'')+'</div><h2>'+esc(m.text)+'</h2><div class="meta"><span>'+esc(m.projectName)+'</span><span>v'+m.version+'</span><span>'+fmt(m.updatedAt)+'</span><span>'+m.sources.length+' 个来源</span></div><p class="reason">'+esc(m.reason)+'</p><button class="open" data-memory="'+esc(m.id)+'">查看证据与谱系 →</button></div><div class="decay"><div class="decay-head"><span>记忆强度</span><b>'+percent+'%</b></div><div class="bar"><i style="width:'+percent+'%"></i></div><p>'+esc(decayLabels[m.decay.reason]||m.decay.reason)+' · '+m.decay.ageDays+' 天</p><p>'+(m.decay.halfLifeDays?'半衰期 '+m.decay.halfLifeDays+' 天':'不按时间降权')+'</p></div></article>';
    }).join('');
    document.querySelectorAll('[data-memory]').forEach(el => el.onclick = () => openDetail(el.dataset.memory));
  }
  function openDetail(id) {
    const m = data.memories.find(x => x.id===id); if (!m) return;
    $('detail-title').textContent = m.text;
    const members = m.lineage.memberIds || [], children = m.lineage.children || [], relations = m.lineage.relations || [], history = m.lineage.history || [];
    $('detail-body').innerHTML = '<section class="section"><h3>状态</h3><div class="chips"><span class="badge '+esc(m.effectiveState)+'">'+esc(labels[m.effectiveState])+'</span><span class="badge '+esc(m.scope)+'">'+esc(labels[m.scope])+'</span><span class="badge">'+esc(labels[m.type])+'</span></div><p>'+esc(m.reason)+'</p><div class="mono">'+esc(m.id)+' · v'+m.version+'<br>'+esc(m.projectName)+' · '+esc(m.projectId)+'</div></section><section class="section"><h3>退化</h3><p>当前权重 '+Math.round(m.decay.weight*100)+'% · '+esc(decayLabels[m.decay.reason]||m.decay.reason)+' · 距离最近使用/更新 '+m.decay.ageDays+' 天</p></section><section class="section"><h3>合并与派生</h3><div class="lineage"><div><b>'+members.length+'</b><span>合并成员</span></div><div><b>'+children.length+'</b><span>派生记忆</span></div><div><b>'+relations.length+'</b><span>证据关系</span></div></div>'+(members.length?'<p class="mono">成员：'+members.map(esc).join('<br>')+'</p>':'')+(children.length?'<p class="mono">派生：'+children.map(esc).join('<br>')+'</p>':'')+'</section><section class="section"><h3>适用条件</h3><p>'+(m.conditions.length?m.conditions.map(esc).join('<br>'):'无显式条件')+'</p><div class="mono">'+esc(JSON.stringify(m.environment||{}))+'</div></section><section class="section"><h3>原始证据</h3>'+(m.sources.length?m.sources.map(s => '<div class="source"><small>'+esc(s.role)+' · '+fmt(s.occurredAt)+' · '+esc(s.taskId)+'</small>'+esc(s.text)+'</div>').join(''):'<p class="quiet">来源已不可用</p>')+'</section><section class="section"><h3>版本历史</h3>'+(history.length?history.map(h => '<div class="history"><small>v'+h.version+' · '+fmt(h.updatedAt)+' · '+esc(labels[h.state]||h.state)+'</small>'+esc(h.reason)+'</div>').join(''):'<p class="quiet">当前是第一个版本</p>')+'</section>';
    $('detail').showModal();
  }
  async function load() {
    if (!token) { $('memories').innerHTML='<div class="error">缺少访问凭据。请从 <span class="mono">banana-memory start</span> 输出的 UI 地址打开本页。</div>'; $('model').textContent='未认证'; return; }
    $('refresh').disabled=true;
    try { const response=await fetch('/api/dashboard',{headers:{Authorization:'Bearer '+token},cache:'no-store'}); if(!response.ok) throw new Error(response.status===401?'访问凭据无效':'服务返回 '+response.status); data=await response.json(); $('model').textContent='本地模型 '+(data.model.phase||'unknown')+(data.model.generationLoaded?' · 生成已加载':'')+(data.model.embeddingLoaded?' · 向量已加载':''); $('updated').textContent='更新于 '+fmt(data.generatedAt); stats(); projectList(); render(); }
    catch(error){$('memories').innerHTML='<div class="error">'+esc(error.message)+'</div>'; $('model').textContent='连接失败';}
    finally{$('refresh').disabled=false;}
  }
  ['search','scope','state','type'].forEach(id => $(id).addEventListener(id==='search'?'input':'change',()=>{visibleLimit=100;render();}));
  $('more').onclick=()=>{visibleLimit+=100;render();};
  $('refresh').onclick=load; document.querySelector('.close').onclick=()=> $('detail').close(); $('detail').onclick=e=>{if(e.target===$('detail'))$('detail').close();};
  load(); setInterval(load,30000);
})();
</script>
</body>
</html>`;
