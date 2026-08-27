(function(){
'use strict';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

let socket = null, currentUser = null, currentUserId = null;
let currentServer = null, currentChannel = null, currentChannelId = null;
let servers = [], currentServerId = null, currentUserRole = 'member';
let localStream = null, isMuted = false, isDeafened = false, currentVoiceChannelId = null;
let peers = {}, isScreenSharing = false, screenStream = null;
let voiceUsersMap = {};
let isCameraOn = false, cameraStream = null;
let speakingCheckInterval = null, localAnalyser = null, localAnalyserData = null;
let replyingTo = null, editingMessageId = null, audioCtx = null;
let typingTimeout = null, typingUsers = new Set();
let hasMoreMessages = true, isLoadingMessages = false;
let membersVisible = true;

function $(id){ return document.getElementById(id); }

function escapeHtml(t){
  if(!t) return '';
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getAvatarUrl(seed){
  if(!seed) return '';
  if(seed.startsWith('http')) return seed;
  if(seed.startsWith('/uploads/avatars/')) return seed;
  return 'https://api.dicebear.com/7.x/adventurer/svg?seed='+encodeURIComponent(seed)+'&size=128';
}

function avatarOnerror(name){
  return 'onerror="this.onerror=null;this.src=\'https://api.dicebear.com/7.x/adventurer/svg?seed='+encodeURIComponent(name)+'&size=128\'"';
}

function formatTime(dateStr){
  if(!dateStr) return '';
  const d=new Date(dateStr);
  const now=new Date();
  const diff=now-d;
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const msgDay=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const timeStr=d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  if(diff<86400000 && today.getTime()===msgDay.getTime()) return 'Hoje '+timeStr;
  if(diff<172800000 && today.getTime()-msgDay.getTime()===86400000) return 'Ontem '+timeStr;
  return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'})+' '+timeStr;
}

function formatShortTime(dateStr){
  if(!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}

function generateColor(str){
  if(!str) return '#7c3aed';
  let h=0;
  for(let i=0;i<str.length;i++) h=str.charCodeAt(i)+((h<<5)-h);
  const colors=['#7c3aed','#3b82f6','#22c55e','#ef4444','#f59e0b','#ec4899','#06b6d4','#8b5cf6','#f97316','#14b8a6'];
  return colors[Math.abs(h)%colors.length];
}

function showToast(type,title,msg){
  const c=$('toast-container');
  const t=document.createElement('div');
  t.className='toast '+type;
  const icons={success:'✓',error:'✕',info:'ℹ'};
  t.innerHTML='<span class="toast-icon">'+(icons[type]||'ℹ')+'</span><div class="toast-content"><strong>'+escapeHtml(title)+'</strong><br>'+escapeHtml(msg)+'</div><button class="toast-close" onclick="this.parentElement.remove()">✕</button>';
  c.appendChild(t);
  setTimeout(()=>{ t.classList.add('removing'); setTimeout(()=>t.remove(),300); },5000);
}

function showModal(id){ const m=$(id); if(m) m.classList.remove('hidden'); }
function hideModal(id){ const m=$(id); if(m) m.classList.add('hidden'); }

document.addEventListener('click',function(e){
  if(e.target.classList.contains('modal-backdrop')) e.target.classList.add('hidden');
  if(e.target.classList.contains('modal-close')) e.target.closest('.modal-backdrop')?.classList.add('hidden');
  if(e.target.classList.contains('modal-cancel')) e.target.closest('.modal-backdrop')?.classList.add('hidden');
});

function renderRichText(content){
  if(!content) return '';
  let s=escapeHtml(content);
  s=s.replace(/```([\s\S]*?)```/g,'<pre><code>$1</code></pre>');
  s=s.replace(/`([^`]+)`/g,'<code>$1</code>');
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\*(.+?)\*/g,'<em>$1</em>');
  s=s.replace(/@(\w+)/g,'<span class="mention">@$1</span>');
  s=s.replace(/((https?:\/\/)[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');
  s=s.replace(/\n/g,'<br>');
  return s;
}

function getToken(){ return localStorage.getItem('token'); }

async function apiCall(url,opts={}){
  const token=getToken();
  const authHeaders=token?{'Authorization':'Bearer '+token}:{};
  try{
    const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json',...authHeaders,...(opts.headers||{})},...((opts.body&&typeof opts.body==='string')?{body:opts.body}:{})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'Erro na requisição');
    return d;
  }catch(e){ throw e; }
}

async function apiUpload(url,formData){
  const token=getToken();
  const headers=token?{'Authorization':'Bearer '+token}:{};
  const r=await fetch(url,{method:'POST',headers,body:formData});
  const d=await r.json();
  if(!r.ok) throw new Error(d.error||'Erro no upload');
  return d;
}

// ─── Auth ──────────────────────────────────────────────────────────────────

$('landing-cta')?.addEventListener('click',()=>{
  $('landing-page').classList.add('hidden');
  $('auth-card').classList.remove('hidden');
  document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
  document.querySelector('.auth-tab[data-tab="login"]').classList.add('active');
  $('login-form').classList.remove('hidden');
  $('register-form').classList.add('hidden');
  $('forgot-form').classList.add('hidden');
  $('reset-form').classList.add('hidden');
});

$('show-login-link')?.addEventListener('click',e=>{
  e.preventDefault();
  $('landing-page').classList.add('hidden');
  $('auth-card').classList.remove('hidden');
  document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
  document.querySelector('.auth-tab[data-tab="login"]').classList.add('active');
  $('login-form').classList.remove('hidden');
  $('register-form').classList.add('hidden');
  $('forgot-form').classList.add('hidden');
  $('reset-form').classList.add('hidden');
});

document.querySelectorAll('.auth-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    const t=tab.dataset.tab;
    $('login-form').classList.toggle('hidden',t!=='login');
    $('register-form').classList.toggle('hidden',t!=='register');
    $('forgot-form').classList.add('hidden');
    $('reset-form').classList.add('hidden');
  });
});

$('forgot-link')?.addEventListener('click',e=>{
  e.preventDefault();
  $('login-form').classList.add('hidden');
  $('register-form').classList.add('hidden');
  $('forgot-form').classList.remove('hidden');
  $('reset-form').classList.add('hidden');
});

$('back-to-login')?.addEventListener('click',e=>{
  e.preventDefault();
  $('forgot-form').classList.add('hidden');
  $('reset-form').classList.add('hidden');
  $('login-form').classList.remove('hidden');
  document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
  document.querySelector('.auth-tab[data-tab="login"]').classList.add('active');
});

$('login-form')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const email=$('login-email').value.trim();
  const password=$('login-password').value;
  $('login-error').classList.add('hidden');
  try{
    const d=await apiCall('/api/login',{method:'POST',body:JSON.stringify({email,password})});
    localStorage.setItem('token',d.token);
    currentUser=d.user; currentUserId=d.user.id;
    enterApp();
  }catch(err){
    $('login-error').textContent=err.message;
    $('login-error').classList.remove('hidden');
  }
});

$('register-form')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const username=$('register-username').value.trim();
  const email=$('register-email').value.trim();
  const password=$('register-password').value;
  const confirm=$('register-confirm').value;
  $('register-error').classList.add('hidden');
  if(password!==confirm){
    $('register-error').textContent='As senhas não conferem';
    $('register-error').classList.remove('hidden');
    return;
  }
  try{
    const d=await apiCall('/api/register',{method:'POST',body:JSON.stringify({username,email,password})});
    localStorage.setItem('token',d.token);
    currentUser=d.user; currentUserId=d.user.id;
    enterApp();
  }catch(err){
    $('register-error').textContent=err.message;
    $('register-error').classList.remove('hidden');
  }
});

$('forgot-form')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const email=$('forgot-email').value.trim();
  $('forgot-error').classList.add('hidden');
  $('forgot-success').classList.add('hidden');
  try{
    const d=await apiCall('/api/forgot-password',{method:'POST',body:JSON.stringify({email})});
    $('forgot-success').textContent=d.message||'Email enviado!';
    $('forgot-success').classList.remove('hidden');
    if(d.resetToken){
      $('reset-token').value=d.resetToken;
      $('forgot-form').classList.add('hidden');
      $('reset-form').classList.remove('hidden');
    }
  }catch(err){
    $('forgot-error').textContent=err.message;
    $('forgot-error').classList.remove('hidden');
  }
});

$('reset-form')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const token=$('reset-token').value.trim();
  const newPassword=$('reset-password').value;
  $('reset-error').classList.add('hidden');
  try{
    await apiCall('/api/reset-password',{method:'POST',body:JSON.stringify({token,newPassword})});
    showToast('success','Sucesso','Senha redefinida! Faça login.');
    $('reset-form').classList.add('hidden');
    $('login-form').classList.remove('hidden');
  }catch(err){
    $('reset-error').textContent=err.message;
    $('reset-error').classList.remove('hidden');
  }
});

async function checkAuth(){
  const token=localStorage.getItem('token');
  if(!token){
    $('auth-screen').classList.remove('hidden');
    $('chat-screen').classList.add('hidden');
    return;
  }
  try{
    const d=await apiCall('/api/me');
    if(d.user){
      currentUser=d.user; currentUserId=d.user.id;
      enterApp();
    }
  }catch(e){
    localStorage.removeItem('token');
    $('auth-screen').classList.remove('hidden');
    $('chat-screen').classList.add('hidden');
  }
}

function enterApp(){
  $('auth-screen').classList.add('hidden');
  $('chat-screen').classList.remove('hidden');
  updateUserUI();
  connectSocket();
  loadServers();
  setupInfiniteScroll();
}

function doLogout(){
  if(socket) socket.disconnect();
  localStorage.removeItem('token');
  currentUser=null; currentUserId=null;
  $('chat-screen').classList.add('hidden');
  $('auth-screen').classList.remove('hidden');
  $('landing-page').classList.remove('hidden');
  $('auth-card').classList.add('hidden');
  cleanupVoice();
}

function updateUserUI(){
  if(!currentUser) return;
  const name=currentUser.username||currentUser.email;
  $('user-display-name').textContent=name;
  const url=getAvatarUrl(currentUser.avatarSeed);
  $('user-avatar-small').innerHTML='<img src="'+url+'" alt="" onerror="this.src=\'https://api.dicebear.com/7.x/adventurer/svg?seed='+encodeURIComponent(name)+'&size=128\'">';
  $('user-avatar-small').style.background=generateColor(name);
}

// ─── Socket ────────────────────────────────────────────────────────────────

function connectSocket(){
  if(socket) socket.disconnect();
  socket=io({auth:{token:localStorage.getItem('token')},transports:['websocket','polling']});

  socket.on('connect',()=>console.log('Socket connected'));
  socket.on('disconnect',()=>console.log('Socket disconnected'));

  socket.on('userInfo',data=>{
    if(data) { currentUser=data; currentUserId=data.id; updateUserUI(); }
  });

  socket.on('channelHistory',msgs=>{
    const list=$('messages-list');
    list.innerHTML='';
    displayMessages(msgs);
    hasMoreMessages=msgs.length>=50;
    scrollToBottom();
  });

  socket.on('chatMessage',msg=>{
    if(!msg) return;
    appendMessages([msg]);
    scrollToBottom();
    if(msg.user_id!==currentUserId) playSound('message');
  });

  socket.on('userTyping',data=>{
    typingUsers.add(data.username);
    updateTypingIndicator();
  });

  socket.on('userStopTyping',data=>{
    typingUsers.delete(data.username);
    updateTypingIndicator();
  });

  socket.on('reactions-update',data=>{
    const el=document.querySelector('[data-msg-id="'+data.messageId+'"] .msg-reactions');
    if(el) el.innerHTML=renderReactions(data.messageId,data.reactions);
  });

  socket.on('user-presence',data=>{
    const el=document.querySelector('[data-user-id="'+data.userId+'"] .member-status');
    if(el){ el.className='member-status'; el.classList.add('status-dot'); el.classList.add(data.status||'offline'); }
  });

  socket.on('voice-connected',data=>{
    currentVoiceChannelId=data.channelId;
    $('voice-connected-panel').classList.remove('hidden');
    const chName=getChannelNameById(data.channelId);
    $('voice-channel-name').textContent=chName||'Canal de Voz';
    playSound('join');
    setupLocalAnalyser();
    initWaveform();
    if(data.existingUsers){
      for(const u of data.existingUsers){
        createPeerConnection(u.socketId,u.userId,u.username,u.avatarSeed,true);
      }
    }
    if(!speakingCheckInterval) startSpeakingDetection();
    updateVoiceChannelUsersUI();
  });

  socket.on('voice-disconnected',()=>{
    playSound('leave');
    voiceUsersMap={};
    cleanupVoice();
  });

  socket.on('voice-user-joined',data=>{
    createPeerConnection(data.socketId,data.userId,data.username,data.avatarSeed,true);
  });

  socket.on('voice-user-left',data=>{
    removePeer(data.socketId);
    removeParticipantCard(data.socketId);
  });

  socket.on('voice-users-list',data=>{
    voiceUsersMap={};
    data.users.forEach(u=>{ voiceUsersMap[u.socketId]={...u,channelId:data.channelId}; });
    updateVoiceUsersList(data.users);
    updateVoiceChannelUsersUI();
  });

  socket.on('voice-offer',async data=>{
    let pc=peers[data.fromSocketId]?.pc;
    if(!pc) return;
    try{
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer=await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('voice-answer',{answer,targetSocketId:data.fromSocketId});
    }catch(e){ console.error('voice-offer error',e); }
  });

  socket.on('voice-answer',async data=>{
    const peer=peers[data.fromSocketId];
    if(!peer?.pc) return;
    try{ await peer.pc.setRemoteDescription(new RTCSessionDescription(data.answer)); }catch(e){}
  });

  socket.on('ice-candidate',async data=>{
    const peer=peers[data.fromSocketId];
    if(!peer?.pc) return;
    try{ await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }catch(e){}
  });

  socket.on('voice-user-muted',data=>{
    const card=document.querySelector('[data-voice-socket="'+data.socketId+'"] .voice-status-indicator');
    if(card) card.textContent=data.isMuted?'🔇':'';
    const vd=peers[data.socketId];
    if(vd) vd.isMuted=data.isMuted;
  });

  socket.on('screen-share-started',data=>{
    const card=document.querySelector('[data-voice-socket="'+data.socketId+'"]');
    if(card){
      if(!card.querySelector('.live-badge')){
        const b=document.createElement('span');
        b.className='live-badge';
        b.textContent='AO VIVO';
        card.appendChild(b);
      }
      card.dataset.screenSharing='1';
    }
    const vd=peers[data.socketId];
    if(vd) vd.isScreenSharing=true;
    if(voiceUsersMap[data.socketId]) voiceUsersMap[data.socketId].isScreenSharing=true;
    updateVoiceChannelUsersUI();
  });

  socket.on('screen-share-stopped',data=>{
    const card=document.querySelector('[data-voice-socket="'+data.socketId+'"]');
    if(card){
      card.querySelector('.live-badge')?.remove();
      card.querySelector('.video-fullscreen-btn')?.remove();
      card.dataset.screenSharing='';
    }
    const vd=peers[data.socketId];
    if(vd) vd.isScreenSharing=false;
    if(voiceUsersMap[data.socketId]) voiceUsersMap[data.socketId].isScreenSharing=false;
    updateVoiceChannelUsersUI();
  });

  socket.on('message-edited',data=>{
    const el=document.querySelector('[data-msg-id="'+data.messageId+'"] .msg-content');
    if(el) el.innerHTML=renderRichText(data.content)+' <small style="color:var(--text-muted)">(editado)</small>';
  });

  socket.on('message-deleted',data=>{
    const el=document.querySelector('[data-msg-id="'+data.messageId+'"]');
    if(el) el.remove();
  });

  socket.on('message-pinned',data=>{
    if(data.action==='pinned') showToast('info','Mensagem Fixada','Uma mensagem foi fixada no canal.');
  });
}

// ─── Servers ───────────────────────────────────────────────────────────────

async function loadServers(){
  try{
    const d=await apiCall('/api/servers');
    servers=d.servers||[];
    renderServers();
    if(servers.length>0 && !currentServer){
      selectServer(servers[0]);
    } else if(servers.length===0){
      $('server-name-display').textContent='NexusChat';
      $('channels-list').innerHTML='<div class="empty-state"><div class="empty-icon">🏠</div><h3>Nenhum servidor</h3><p>Crie ou entre em um servidor</p></div>';
    }
  }catch(e){ console.error('loadServers',e); }
}

function renderServers(){
  const list=$('server-list');
  list.innerHTML='';
  servers.forEach(s=>{
    const initial=(s.name||'?')[0].toUpperCase();
    const div=document.createElement('div');
    div.className='server-icon-wrapper'+(currentServerId===s.id?' active':'');
    div.dataset.tooltip=s.name;
    div.innerHTML='<span class="server-pill"></span><div class="server-icon" style="background:'+generateColor(s.name)+'">'+initial+'</div>';
    div.addEventListener('click',()=>selectServer(s));
    list.appendChild(div);
  });
}

async function selectServer(server){
  currentServer=server;
  currentServerId=server.id;
  currentUserRole=server.role||'member';
  $('server-name-display').textContent=server.name;
  hideServerMenu();
  renderServers();
  renderChannels(server.channels||[]);
  const firstText=(server.channels||[]).find(c=>c.type==='text');
  if(firstText) selectChannel(firstText);
  else {
    $('messages-list').innerHTML='<div class="empty-state"><div class="empty-icon">💬</div><h3>Nenhum canal de texto</h3></div>';
    $('channel-name-display').textContent='';
  }
  loadMembers(server.id);
  updateServerMenuVisibility();
}

function updateServerMenuVisibility(){
  const isOwner=currentUserRole==='owner';
  const isMod=isOwner||currentUserRole==='admin'||currentUserRole==='moderator';
  const ctxSettings=$('ctx-server-settings');
  const ctxCreateCh=$('ctx-create-channel');
  const ctxLeave=$('ctx-leave-server');
  if(ctxSettings) ctxSettings.style.display=isOwner?'flex':'none';
  if(ctxCreateCh) ctxCreateCh.style.display=isMod?'flex':'none';
  if(ctxLeave) ctxLeave.style.display=isOwner?'none':'flex';
}

function showServerMenu(){ $('server-menu').classList.remove('hidden'); }
function hideServerMenu(){ $('server-menu').classList.add('hidden'); }

$('server-header')?.addEventListener('click',e=>{
  e.stopPropagation();
  if(!currentServer) return;
  const menu=$('server-menu');
  if(menu.classList.contains('hidden')) showServerMenu();
  else hideServerMenu();
});

document.addEventListener('click',e=>{
  if(!e.target.closest('#server-header')&&!e.target.closest('#server-menu')) hideServerMenu();
  hideContextMenu();
});

$('ctx-invite')?.addEventListener('click',async()=>{
  if(!currentServer) return;
  try{
    const d=await apiCall('/api/servers/'+currentServer.id+'/invite');
    $('invite-code-display').value=d.inviteCode;
    showModal('invite-modal');
  }catch(e){ showToast('error','Erro',e.message); }
  hideServerMenu();
});

$('copy-invite-btn')?.addEventListener('click',()=>{
  navigator.clipboard.writeText($('invite-code-display').value);
  showToast('success','Copiado','Código copiado!');
});

$('ctx-server-settings')?.addEventListener('click',()=>{
  if(!currentServer) return;
  $('settings-server-name').value=currentServer.name||'';
  $('settings-server-desc').value=currentServer.description||'';
  showModal('server-settings-modal');
  hideServerMenu();
});

$('save-server-settings')?.addEventListener('click',async()=>{
  if(!currentServer) return;
  try{
    await apiCall('/api/servers/'+currentServer.id,{method:'PUT',body:JSON.stringify({name:$('settings-server-name').value,description:$('settings-server-desc').value})});
    currentServer.name=$('settings-server-name').value;
    currentServer.description=$('settings-server-desc').value;
    $('server-name-display').textContent=currentServer.name;
    renderServers();
    hideModal('server-settings-modal');
    showToast('success','Salvo','Configurações atualizadas');
  }catch(e){ showToast('error','Erro',e.message); }
});

$('delete-server-btn')?.addEventListener('click',async()=>{
  if(!currentServer) return;
  if(!confirm('Tem certeza que deseja deletar este servidor? Esta ação é irreversível.')) return;
  try{
    await apiCall('/api/servers/'+currentServer.id,{method:'DELETE'});
    hideModal('server-settings-modal');
    currentServer=null; currentServerId=null;
    await loadServers();
    showToast('success','Deletado','Servidor removido');
  }catch(e){ showToast('error','Erro',e.message); }
});

$('ctx-leave-server')?.addEventListener('click',async()=>{
  if(!currentServer) return;
  if(!confirm('Deseja sair deste servidor?')) return;
  try{
    await apiCall('/api/servers/'+currentServer.id+'/leave',{method:'DELETE'});
    hideServerMenu();
    currentServer=null; currentServerId=null;
    await loadServers();
    showToast('success','Saiu','Você saiu do servidor');
  }catch(e){ showToast('error','Erro',e.message); }
});

$('ctx-create-channel')?.addEventListener('click',()=>{
  $('channel-name-input').value='';
  $('channel-type-input').value='text';
  $('create-channel-error').classList.add('hidden');
  showModal('create-channel-modal');
  hideServerMenu();
});

$('create-channel-submit')?.addEventListener('click',async()=>{
  if(!currentServer) return;
  const name=$('channel-name-input').value.trim();
  const type=$('channel-type-input').value;
  $('create-channel-error').classList.add('hidden');
  try{
    const d=await apiCall('/api/servers/'+currentServer.id+'/channels',{method:'POST',body:JSON.stringify({name,type})});
    currentServer.channels=d.channels;
    renderChannels(d.channels);
    hideModal('create-channel-modal');
    showToast('success','Canal criado',name);
  }catch(e){
    $('create-channel-error').textContent=e.message;
    $('create-channel-error').classList.remove('hidden');
  }
});

$('add-server-btn')?.addEventListener('click',()=>{
  $('server-name-input').value='';
  $('create-server-error').classList.add('hidden');
  showModal('create-server-modal');
});

$('create-server-submit')?.addEventListener('click',async()=>{
  const name=$('server-name-input').value.trim();
  $('create-server-error').classList.add('hidden');
  try{
    const d=await apiCall('/api/servers',{method:'POST',body:JSON.stringify({name})});
    showToast('success','Servidor criado',name);
    hideModal('create-server-modal');
    await loadServers();
    const srv=servers.find(s=>s.id===d.server.id);
    if(srv) selectServer(srv);
  }catch(e){
    $('create-server-error').textContent=e.message;
    $('create-server-error').classList.remove('hidden');
  }
});

$('join-server-btn')?.addEventListener('click',()=>{
  $('invite-code-input').value='';
  $('join-server-error').classList.add('hidden');
  showModal('join-server-modal');
});

$('join-server-submit')?.addEventListener('click',async()=>{
  const code=$('invite-code-input').value.trim();
  $('join-server-error').classList.add('hidden');
  try{
    await apiCall('/api/servers/join',{method:'POST',body:JSON.stringify({inviteCode:code})});
    hideModal('join-server-modal');
    showToast('success','Entrou','Você entrou no servidor!');
    await loadServers();
  }catch(e){
    $('join-server-error').textContent=e.message;
    $('join-server-error').classList.remove('hidden');
  }
});

// ─── Channels ──────────────────────────────────────────────────────────────

function renderChannels(channels){
  const list=$('channels-list');
  list.innerHTML='';
  if(!channels||channels.length===0){
    list.innerHTML='<div class="empty-state"><div class="empty-icon">💬</div><h3>Nenhum canal</h3></div>';
    return;
  }

  const textChannels=channels.filter(c=>c.type==='text');
  const voiceChannels=channels.filter(c=>c.type==='voice');

  if(textChannels.length>0){
    const cat=document.createElement('div');
    cat.className='channel-category';
    cat.innerHTML='<div class="category-header"><span class="category-chevron">▼</span><span class="category-name">Canais de Texto</span><button class="add-channel-btn" title="Criar canal">+</button></div>';
    const chList=document.createElement('div');
    chList.className='channel-category-list';
    textChannels.forEach(ch=>{
      const item=document.createElement('div');
      item.className='channel-item'+(currentChannelId===ch.id?' active':'');
      item.dataset.channelId=ch.id;
      item.innerHTML='<span class="channel-icon">#</span><span class="channel-label">'+escapeHtml(ch.name)+'</span>';
      item.addEventListener('click',()=>selectChannel(ch));
      chList.appendChild(item);
    });
    cat.appendChild(chList);
    cat.querySelector('.add-channel-btn')?.addEventListener('click',()=>{
      $('ctx-create-channel')?.click();
    });
    list.appendChild(cat);
  }

  if(voiceChannels.length>0){
    const cat=document.createElement('div');
    cat.className='channel-category';
    cat.innerHTML='<div class="category-header"><span class="category-chevron">▼</span><span class="category-name">Canais de Voz</span></div>';
    const chList=document.createElement('div');
    chList.className='channel-category-list';
    voiceChannels.forEach(ch=>{
      const item=document.createElement('div');
      item.className='channel-item voice-channel-item'+(currentVoiceChannelId===ch.id?' active':'');
      item.dataset.channelId=ch.id;
      item.innerHTML='<span class="channel-icon">🔊</span><span class="channel-label">'+escapeHtml(ch.name)+'</span>';
      const header=item;
      header.addEventListener('click',()=>{
        if(currentVoiceChannelId!==ch.id){
          joinVoiceChannel(ch);
        }
      });
      chList.appendChild(item);

      const usersDiv=document.createElement('div');
      usersDiv.className='voice-channel-users';
      usersDiv.id='voice-users-'+ch.id;
      chList.appendChild(usersDiv);
    });
    cat.appendChild(chList);
    list.appendChild(cat);
  }
}

function selectChannel(ch){
  if(!ch||ch.type!=='text') return;
  if(currentChannelId && currentChannelId!==currentVoiceChannelId){
    socket?.emit('leaveRoom','channel:'+currentChannelId);
  }
  currentChannel=ch;
  currentChannelId=ch.id;
  $('channel-name-display').textContent=ch.name;
  $('channel-topic').textContent='Canal de texto';
  $('message-input').placeholder='Enviar mensagem em #'+ch.name;
  hasMoreMessages=true;
  isLoadingMessages=false;
  replyingTo=null;
  editingMessageId=null;
  $('reply-indicator').classList.add('hidden');
  document.querySelectorAll('.channel-item').forEach(el=>{
    el.classList.toggle('active',parseInt(el.dataset.channelId)===ch.id);
  });
  socket?.emit('joinRoom','channel:'+ch.id);
  loadPinnedMessages(ch.id);
}

// ─── Messages ──────────────────────────────────────────────────────────────

async function loadMessages(channelId,before){
  if(isLoadingMessages) return;
  isLoadingMessages=true;
  try{
    let url='/api/channels/'+channelId+'/messages?limit=50';
    if(before) url+='&before='+before;
    const d=await apiCall(url);
    if(before){
      appendMessagesAtTop(d.messages||[]);
    } else {
      const list=$('messages-list');
      list.innerHTML='';
      displayMessages(d.messages||[]);
    }
    hasMoreMessages=d.hasMore!==false;
  }catch(e){ console.error('loadMessages',e); }
  isLoadingMessages=false;
}

function displayMessages(messages){
  const list=$('messages-list');
  const existingIds=new Set();
  list.querySelectorAll('[data-msg-id]').forEach(el=>existingIds.add(el.dataset.msgId));

  let prevMsg=null;
  messages.forEach(msg=>{
    if(existingIds.has(String(msg.id))) return;
    const showHeader=!prevMsg || prevMsg.user_id!==msg.user_id || (new Date(msg.created_at)-new Date(prevMsg.created_at)>300000);
    const el=renderMessage(msg,showHeader);
    list.appendChild(el);
    prevMsg=msg;
  });
}

function appendMessages(messages){
  const list=$('messages-list');
  const lastMsg=list.querySelector('[data-msg-id]:last-child');
  let prevMsg=null;
  if(lastMsg){
    const lastId=lastMsg.dataset.msgId;
    const allMsgs=list.querySelectorAll('[data-msg-id]');
    prevMsg={user_id:allMsgs[allMsgs.length-1]?.dataset?.userId};
  }
  messages.forEach(msg=>{
    const existingIds=new Set();
    list.querySelectorAll('[data-msg-id]').forEach(el=>existingIds.add(el.dataset.msgId));
    if(existingIds.has(String(msg.id))) return;
    const showHeader=!prevMsg || prevMsg.user_id!==msg.user_id || true;
    const el=renderMessage(msg,true);
    list.appendChild(el);
    prevMsg=msg;
  });
}

function appendMessagesAtTop(messages){
  const list=$('messages-list');
  const trigger=$('load-more-trigger');
  const prevFirst=list.querySelector('[data-msg-id]');
  let prevUserId=prevFirst?.dataset?.userId;
  let prevTime=prevFirst?.dataset?.msgTime;

  messages.forEach(msg=>{
    const existing=list.querySelector('[data-msg-id="'+msg.id+'"]');
    if(existing) return;
    const showHeader=!prevUserId || prevUserId!=msg.user_id || (prevTime && (new Date(msg.created_at)-new Date(prevTime)>300000));
    const el=renderMessage(msg,showHeader);
    list.insertBefore(el,list.firstChild?.nextSibling);
    prevUserId=String(msg.user_id);
    prevTime=msg.created_at;
  });
}

function renderMessage(msg,showHeader){
  const div=document.createElement('div');
  div.dataset.msgId=msg.id;
  div.dataset.userId=msg.user_id;
  div.dataset.msgTime=msg.created_at;
  div.className='message-group'+(showHeader?'':' grouped');

  const isOwn=msg.user_id===currentUserId;
  const name=msg.username||'User';
  const avatarUrl=getAvatarUrl(msg.avatar_seed);
  const reactions=msg.reactions||[];
  const hasFile=msg.content && (msg.content.includes('/uploads/') || /\.(png|jpg|jpeg|gif|webp|mp4|pdf|zip|txt)$/i.test(msg.content));
  const fileUrl=msg.content?.match(/\/uploads\/[^\s"<>]+/)?.[0];

  let replyHtml='';
  if(msg.reply_to_id||msg.reply_to){
    const rid=msg.reply_to_id||msg.reply_to;
    replyHtml='<div class="msg-reply-bar"><span class="reply-line"></span><span class="reply-avatar">↩</span><span class="reply-name">Mensagem referenciada</span></div>';
  }

  let editedHtml='';
  if(msg.edited) editedHtml=' <small style="color:var(--text-muted)">(editado)</small>';

  let fileHtml='';
  if(hasFile&&fileUrl){
    if(/\.(png|jpg|jpeg|gif|webp)$/i.test(fileUrl)){
      fileHtml='<div class="msg-image"><img src="'+fileUrl+'" alt="" loading="lazy"></div>';
    } else {
      fileHtml='<div style="margin-top:4px"><a href="'+fileUrl+'" target="_blank" class="btn btn-sm btn-secondary">📎 '+escapeHtml(fileUrl.split('/').pop())+'</a></div>';
    }
  }

  div.innerHTML=
    '<div class="msg-avatar" onclick="window._showProfile('+msg.user_id+',\''+escapeHtml(name)+'\',\''+(msg.avatar_seed||'')+'\')">'+(avatarUrl?'<img src="'+avatarUrl+'" alt="" '+avatarOnerror(name)+'>':name[0]?.toUpperCase()||'?')+'</div>'+
    '<div class="msg-body">'+replyHtml+
    '<div class="msg-header"><span class="msg-author" style="color:'+generateColor(name)+'" onclick="window._showProfile('+msg.user_id+',\''+escapeHtml(name)+'\',\''+(msg.avatar_seed||'')+'\')">'+escapeHtml(name)+'</span><span class="msg-timestamp">'+formatTime(msg.created_at)+'</span></div>'+
    '<span class="msg-timestamp-inline">'+formatShortTime(msg.created_at)+'</span>'+
    '<div class="msg-content">'+(fileHtml?fileHtml:renderRichText(msg.content))+editedHtml+'</div>'+
    '<div class="msg-reactions">'+renderReactions(msg.id,reactions)+'</div>'+
    '</div>'+
    '<div class="msg-actions">'+
    '<button onclick="window._replyMsg('+msg.id+',\''+escapeHtml(name)+'\')" title="Responder">↩</button>'+
    (isOwn?'<button onclick="window._editMsg('+msg.id+',this.closest(\'[data-msg-id]\').querySelector(\'.msg-content\').textContent)" title="Editar">✏️</button>':'')+
    (isOwn||currentUserRole==='owner'||currentUserRole==='admin'||currentUserRole==='moderator'?'<button onclick="window._deleteMsg('+msg.id+')" title="Deletar">🗑️</button>':'')+
    '<button onclick="window._pinMsg('+msg.id+')" title="Fixar">📌</button>'+
    '<button onclick="window._showReactionPicker(event,'+msg.id+')" title="Reagir">😊</button>'+
    '<button onclick="window._copyText('+msg.id+')" title="Copiar">📋</button>'+
    '</div>';

  return div;
}

function renderReactions(messageId,reactions){
  if(!reactions||reactions.length===0) return '';
  return reactions.map(r=>{
    const isActive=r.users&&r.users.includes(currentUser?.username);
    return '<span class="reaction-chip'+(isActive?' active':'')+'" onclick="window._toggleReaction('+messageId+',\''+escapeHtml(r.emoji)+'\')">'+r.emoji+' <span class="count">'+r.count+'</span></span>';
  }).join('');
}

function scrollToBottom(){
  const c=$('messages-container');
  if(c) setTimeout(()=>c.scrollTop=c.scrollHeight,50);
}

// ─── Chat Input ────────────────────────────────────────────────────────────

$('send-btn')?.addEventListener('click',sendMessage);

$('message-input')?.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); }
  handleTyping();
});

$('message-input')?.addEventListener('input',()=>{
  const ta=$('message-input');
  ta.style.height='auto';
  ta.style.height=Math.min(ta.scrollHeight,200)+'px';
  handleTyping();
});

async function sendMessage(){
  const input=$('message-input');
  const text=input.value.trim();
  if(!text||!socket||!currentChannelId) return;

  const data={text};
  if(replyingTo){
    data.replyTo=replyingTo;
    replyingTo=null;
    $('reply-indicator').classList.add('hidden');
  }

  socket.emit('chatMessage',data);
  socket.emit('stopTyping');
  input.value='';
  input.style.height='auto';
  if(typingTimeout){ clearTimeout(typingTimeout); typingTimeout=null; }
}

function handleTyping(){
  if(!socket) return;
  socket.emit('typing');
  if(typingTimeout) clearTimeout(typingTimeout);
  typingTimeout=setTimeout(()=>socket.emit('stopTyping'),3000);
}

function updateTypingIndicator(){
  const el=$('typing-indicator');
  const txt=$('typing-text');
  const users=[...typingUsers];
  if(users.length===0){ el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if(users.length===1) txt.textContent=users[0]+' está digitando...';
  else if(users.length===2) txt.textContent=users[0]+' e '+users[1]+' estão digitando...';
  else txt.textContent=users.length+' pessoas estão digitando...';
}

window._replyMsg=function(id,username){
  replyingTo=id;
  $('reply-indicator').classList.remove('hidden');
  $('reply-to-name').textContent=username;
  $('message-input').focus();
};

$('cancel-reply')?.addEventListener('click',()=>{
  replyingTo=null;
  $('reply-indicator').classList.add('hidden');
});

window._editMsg=function(id,currentContent){
  editingMessageId=id;
  const el=document.querySelector('[data-msg-id="'+id+'"] .msg-content');
  if(!el) return;
  const text=currentContent.replace(/\(editado\)/,'').trim();
  el.innerHTML='<textarea class="form-input form-textarea" id="edit-textarea" style="min-height:60px;width:100%">'+escapeHtml(text)+'</textarea>'+
    '<div style="display:flex;gap:8px;margin-top:8px">'+
    '<button class="btn btn-primary btn-sm" onclick="window._saveEdit()">Salvar</button>'+
    '<button class="btn btn-ghost btn-sm" onclick="window._cancelEdit('+id+')">Cancelar</button></div>';
};

window._saveEdit=async function(){
  if(!editingMessageId) return;
  const textarea=$('edit-textarea');
  if(!textarea) return;
  const content=textarea.value.trim();
  if(!content) return;
  try{
    await apiCall('/api/messages/'+editingMessageId,{method:'PUT',body:JSON.stringify({content})});
    socket?.emit('message-edited',{messageId:editingMessageId,content});
    const el=document.querySelector('[data-msg-id="'+editingMessageId+'"] .msg-content');
    if(el) el.innerHTML=renderRichText(content)+' <small style="color:var(--text-muted)">(editado)</small>';
    editingMessageId=null;
  }catch(e){ showToast('error','Erro',e.message); }
};

window._cancelEdit=function(id){
  editingMessageId=null;
  if(currentChannelId) loadMessages(currentChannelId);
};

window._deleteMsg=async function(id){
  if(!confirm('Tem certeza que deseja deletar esta mensagem?')) return;
  try{
    await apiCall('/api/messages/'+id,{method:'DELETE'});
    socket?.emit('message-deleted',{messageId:id});
    const el=document.querySelector('[data-msg-id="'+id+'"]');
    if(el) el.remove();
  }catch(e){ showToast('error','Erro',e.message); }
};

window._pinMsg=async function(id){
  if(!currentChannelId) return;
  try{
    const d=await apiCall('/api/channels/'+currentChannelId+'/messages/'+id+'/pin',{method:'POST'});
    socket?.emit('message-pinned',{messageId:id,action:d.action});
    showToast('info','Pin',d.action==='pinned'?'Mensagem fixada!':'Mensagem desfixada!');
  }catch(e){ showToast('error','Erro',e.message); }
};

window._copyText=function(id){
  const el=document.querySelector('[data-msg-id="'+id+'"] .msg-content');
  if(el) navigator.clipboard.writeText(el.textContent);
};

// ─── Reactions ─────────────────────────────────────────────────────────────

window._toggleReaction=async function(messageId,emoji){
  if(!currentChannelId) return;
  try{
    await apiCall('/api/channels/'+currentChannelId+'/messages/'+messageId+'/reactions',{method:'POST',body:JSON.stringify({emoji})});
    socket?.emit('reaction',{messageId,emoji});
  }catch(e){}
};

window._showReactionPicker=function(e,messageId){
  e.stopPropagation();
  const emojis=['😀','😂','😍','🥳','🤔','😮','😢','😡','👍','👎','❤️','🔥','🎉','💯','👀','✨','💪','🙏','😊','🤩','😎','🤣','😭','😱','🤝','💀','👻','🫡','🤡','💅'];
  const picker=document.createElement('div');
  picker.className='context-menu';
  picker.style.top=e.clientY+'px';
  picker.style.left=Math.min(e.clientX,window.innerWidth-200)+'px';
  picker.innerHTML=emojis.map(em=>'<div class="ctx-item" onclick="window._toggleReaction('+messageId+',\''+em+'\');this.closest(\'.context-menu\').remove()">'+em+'</div>').join('');
  document.body.appendChild(picker);
  setTimeout(()=>picker.remove(),5000);
};

function hideContextMenu(){ document.querySelectorAll('.context-menu').forEach(c=>c.remove()); }

// ─── Context Menu ──────────────────────────────────────────────────────────

window._showProfile=function(userId,name,seed){
  $('profile-username-display').textContent=name;
  $('profile-display-name').textContent=name;
  $('profile-avatar-large').innerHTML='<img src="'+getAvatarUrl(seed)+'" alt="" style="width:100%;height:100%;object-fit:cover" '+avatarOnerror(name)+'>';
  $('profile-avatar-large').style.background=generateColor(name);
  $('profile-display-status').textContent='';
  $('profile-role-badges').innerHTML='';
  showModal('user-profile-modal');
};

// ─── Emoji Picker ──────────────────────────────────────────────────────────

const EMOJI_LIST=[
  '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙',
  '🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥',
  '😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯',
  '🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰',
  '😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩',
  '🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','👋','🤚','🖐️','✋',
  '🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️',
  '🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','❤️','🧡','💛','💚','💙','💜',
  '🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','❣️','💕','💞','💓','💗','💖','💘','💝','💟','🔥','💯','🎉','🎊',
  '✨','⭐','🌟','💫','🌈','☀️','🌙','⚡','🔥','👍','👎','💯','✅','❌','⚠️','🔄','🆕','🆓','🔝','🔜'
];

function renderEmojis(){
  const grid=$('emoji-grid');
  if(!grid) return;
  grid.innerHTML='';
  EMOJI_LIST.forEach(em=>{
    const btn=document.createElement('div');
    btn.className='emoji-item';
    btn.textContent=em;
    btn.addEventListener('click',()=>insertEmoji(em));
    grid.appendChild(btn);
  });
}

function insertEmoji(emoji){
  const input=$('message-input');
  if(!input) return;
  const start=input.selectionStart;
  const end=input.selectionEnd;
  input.value=input.value.substring(0,start)+emoji+input.value.substring(end);
  input.focus();
  input.selectionStart=input.selectionEnd=start+emoji.length;
  toggleEmojiPicker();
}

$('emoji-btn')?.addEventListener('click',toggleEmojiPicker);

function toggleEmojiPicker(){
  const picker=$('emoji-picker');
  if(picker.classList.contains('hidden')){
    renderEmojis();
    picker.classList.remove('hidden');
  } else {
    picker.classList.add('hidden');
  }
}

$('emoji-search')?.addEventListener('input',e=>{
  const q=e.target.value.toLowerCase();
  document.querySelectorAll('.emoji-item').forEach(el=>{
    el.style.display=el.textContent.toLowerCase().includes(q)?'':'none';
  });
});

document.addEventListener('click',e=>{
  if(!e.target.closest('#emoji-picker')&&!e.target.closest('#emoji-btn')){
    $('emoji-picker')?.classList.add('hidden');
  }
});

// ─── Pinned Messages ───────────────────────────────────────────────────────

$('pins-btn')?.addEventListener('click',()=>{
  const panel=$('pins-panel');
  const searchPanel=$('search-panel');
  if(!panel.classList.contains('hidden')){ panel.classList.add('hidden'); return; }
  searchPanel?.classList.add('hidden');
  panel.classList.remove('hidden');
  if(currentChannelId) loadPinnedMessages(currentChannelId);
});

$('close-pins-btn')?.addEventListener('click',()=>$('pins-panel')?.classList.add('hidden'));

async function loadPinnedMessages(channelId){
  if(!channelId) return;
  try{
    const d=await apiCall('/api/channels/'+channelId+'/pins');
    const list=$('pins-list');
    if(!d.pins||d.pins.length===0){
      list.innerHTML='<div class="empty-state"><div class="empty-icon">📌</div><h3>Nenhuma mensagem fixada</h3></div>';
      return;
    }
    list.innerHTML=d.pins.map(p=>
      '<div class="pinned-item"><div class="pinned-header"><span class="pinned-avatar" style="background:'+generateColor(p.username)+'">'+(p.username||'?')[0]+'</span><span class="pinned-author">'+escapeHtml(p.username)+'</span><span class="pinned-date">'+formatTime(p.created_at)+'</span></div><div class="pinned-content">'+renderRichText(p.content)+'</div><button class="unpin-btn btn-icon" onclick="window._pinMsg('+p.id+')">🗑️</button></div>'
    ).join('');
  }catch(e){}
}

// ─── Search ────────────────────────────────────────────────────────────────

$('search-btn')?.addEventListener('click',()=>{
  const panel=$('search-panel');
  const pinsPanel=$('pins-panel');
  if(!panel.classList.contains('hidden')){ panel.classList.add('hidden'); return; }
  pinsPanel?.classList.add('hidden');
  panel.classList.remove('hidden');
  $('search-input')?.focus();
});

$('close-search-btn')?.addEventListener('click',()=>$('search-panel')?.classList.add('hidden'));

let searchDebounce=null;
$('search-input')?.addEventListener('input',e=>{
  clearTimeout(searchDebounce);
  searchDebounce=setTimeout(()=>performSearch(e.target.value),300);
});

$('search-input')?.addEventListener('keydown',e=>{
  if(e.key==='Enter') performSearch(e.target.value);
});

async function performSearch(query){
  if(!currentChannelId||!query||query.length<2) return;
  try{
    const d=await apiCall('/api/channels/'+currentChannelId+'/search?q='+encodeURIComponent(query));
    const list=$('search-results');
    if(!d.messages||d.messages.length===0){
      list.innerHTML='<div class="empty-state"><div class="empty-icon">🔍</div><h3>Nenhum resultado</h3></div>';
      return;
    }
    list.innerHTML=d.messages.map(m=>
      '<div class="search-result-item"><div class="result-author" style="color:'+generateColor(m.username)+'">'+escapeHtml(m.username)+'</div><div class="result-content">'+renderRichText(m.content)+'</div><div class="result-time">'+formatTime(m.created_at)+'</div></div>'
    ).join('');
  }catch(e){}
}

// ─── File Upload ───────────────────────────────────────────────────────────

$('attach-btn')?.addEventListener('click',()=>$('file-input')?.click());

$('file-input')?.addEventListener('change',async e=>{
  const file=e.target.files[0];
  if(!file) return;
  await handleFileUpload(file);
  e.target.value='';
});

document.addEventListener('dragover',e=>{ e.preventDefault(); });
document.addEventListener('drop',async e=>{
  e.preventDefault();
  if(!currentChannelId) return;
  const files=e.dataTransfer?.files;
  if(files&&files.length>0) await handleFileUpload(files[0]);
});

async function handleFileUpload(file){
  if(!currentChannelId) return;
  try{
    const fd=new FormData();
    fd.append('file',file);
    const d=await apiUpload('/api/upload',fd);
    if(d.success&&d.file){
      socket?.emit('chatMessage',{text:d.file.url});
      showToast('success','Enviado',file.name);
    }
  }catch(e){ showToast('error','Erro',e.message); }
}

$('upload-avatar-btn')?.addEventListener('click',()=>$('avatar-file-input')?.click());

$('avatar-file-input')?.addEventListener('change',async e=>{
  const file=e.target.files[0];
  if(!file) return;
  await handleAvatarUpload(file);
  e.target.value='';
});

async function handleAvatarUpload(file){
  try{
    const fd=new FormData();
    fd.append('avatar',file);
    const d=await apiUpload('/api/avatar',fd);
    if(d.success){
      currentUser.avatarSeed=d.avatarUrl;
      updateUserUI();
      showToast('success','Avatar','Avatar atualizado!');
    }
  }catch(e){ showToast('error','Erro',e.message); }
}

$('remove-avatar-btn')?.addEventListener('click',async()=>{
  try{
    await fetch('/api/avatar',{method:'DELETE'});
    currentUser.avatarSeed=null;
    updateUserUI();
    showToast('info','Avatar','Avatar removido');
  }catch(e){ showToast('error','Erro',e.message); }
});

// ─── User Settings ─────────────────────────────────────────────────────────

$('user-settings-btn')?.addEventListener('click',openSettings);

function openSettings(){
  if(!currentUser) return;
  const overlay=$('settings-overlay');
  if(!overlay) return;
  overlay.classList.remove('hidden');
  document.body.style.overflow='hidden';
  loadAudioDevices();
  $('settings-avatar').innerHTML='<img src="'+getAvatarUrl(currentUser.avatarSeed)+'" alt="" '+avatarOnerror(currentUser.username)+'>';
  $('settings-username').textContent=currentUser.username||'';
  $('settings-tag').textContent='#'+(currentUser.id||'');
  $('settings-username-display').textContent=currentUser.username||'';
  $('settings-email-display').textContent='••••••••@gmail.com';
  $('settings-email-full').textContent=currentUser.email||'';
  $('settings-member-since').textContent=currentUser.created_at?new Date(currentUser.created_at).toLocaleDateString('pt-BR',{day:'numeric',month:'long',year:'numeric'}):'';
  updateProfilePreview();
}

function closeSettings(){
  const overlay=$('settings-overlay');
  if(overlay) overlay.classList.add('hidden');
  document.body.style.overflow='';
}

$('settings-close-btn')?.addEventListener('click',closeSettings);
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!$('settings-overlay')?.classList.contains('hidden')) closeSettings(); });

// Settings nav
document.querySelectorAll('.settings-nav-item').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.settings-nav-item').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.settings-tab').forEach(t=>t.classList.remove('active'));
    const tab=document.getElementById('tab-'+btn.dataset.settingsTab);
    if(tab) tab.classList.add('active');
  });
});

// Avatar upload in settings
$('settings-upload-avatar-btn')?.addEventListener('click',()=>$('settings-avatar-input')?.click());
$('settings-avatar-input')?.addEventListener('change',async e=>{
  const file=e.target.files[0]; if(!file) return;
  const fd=new FormData(); fd.append('avatar',file);
  try{
    const d=await fetch('/api/users/avatar',{method:'POST',headers:{'Authorization':'Bearer '+getToken()},body:fd}).then(r=>r.json());
    if(d.avatarUrl){ currentUser.avatarSeed=d.avatarUrl; updateUserUI(); updateProfilePreview(); showToast('success','Avatar','Avatar atualizado!'); }
    else showToast('error','Erro',d.error||'Falha ao enviar avatar');
  }catch(e){ showToast('error','Erro',e.message); }
});

$('settings-remove-avatar-btn')?.addEventListener('click',async()=>{
  try{
    const d=await apiCall('/api/users/avatar',{method:'DELETE'});
    if(d.success){ currentUser.avatarSeed=currentUser.username; updateUserUI(); updateProfilePreview(); showToast('info','Avatar','Avatar removido'); }
  }catch(e){ showToast('error','Erro',e.message); }
});

// Save username
$('save-username-btn')?.addEventListener('click',async()=>{
  const newUsername=$('settings-username-input')?.value?.trim();
  if(!newUsername) return;
  try{
    const d=await apiCall('/api/users/username',{method:'PUT',body:JSON.stringify({username:newUsername})});
    if(d.user){ currentUser.username=d.user.username; updateUserUI(); $('settings-username-display').textContent=d.user.username; $('settings-username').textContent=d.user.username; $('edit-username-input').classList.add('hidden'); showToast('success','Salvo','Nome de usuário atualizado!'); }
    else showToast('error','Erro',d.error||'Falha ao salvar');
  }catch(e){ showToast('error','Erro',e.message); }
});

// Save status
$('settings-save-status-btn')?.addEventListener('click',async()=>{
  try{
    const status=$('settings-status-select')?.value;
    const customStatus=$('settings-custom-status')?.value;
    await apiCall('/api/users/status',{method:'PUT',body:JSON.stringify({status,customStatus})});
    socket?.emit('set-status',{status,customStatus});
    showToast('success','Salvo','Status atualizado!');
  }catch(e){ showToast('error','Erro',e.message); }
});

// Change password
$('settings-change-pw-btn')?.addEventListener('click',async()=>{
  const cur=$('settings-current-pw')?.value;
  const nw=$('settings-new-pw')?.value;
  const cf=$('settings-confirm-pw')?.value;
  const errEl=$('settings-security-error');
  if(!cur||!nw){ errEl.textContent='Preencha todos os campos'; errEl.classList.remove('hidden'); return; }
  if(nw!==cf){ errEl.textContent='As senhas não coincidem'; errEl.classList.remove('hidden'); return; }
  if(nw.length<6){ errEl.textContent='Senha deve ter pelo menos 6 caracteres'; errEl.classList.remove('hidden'); return; }
  try{
    await apiCall('/api/users/password',{method:'PUT',body:JSON.stringify({currentPassword:cur,newPassword:nw})});
    showToast('success','Senha','Senha alterada!');
    $('settings-current-pw').value=''; $('settings-new-pw').value=''; $('settings-confirm-pw').value='';
    errEl.classList.add('hidden');
  }catch(e){ errEl.textContent=e.message; errEl.classList.remove('hidden'); }
});

// Bio
$('settings-save-bio-btn')?.addEventListener('click',async()=>{
  const bio=$('settings-bio-input')?.value;
  try{
    await apiCall('/api/users/profile',{method:'PUT',body:JSON.stringify({bio})});
    showToast('success','Salvo','Bio atualizada!');
    updateProfilePreview();
  }catch(e){ showToast('error','Erro',e.message); }
});

// Profile color
$('settings-profile-color')?.addEventListener('input',e=>{
  $('settings-color-display').textContent=e.target.value;
});
$('settings-save-color-btn')?.addEventListener('click',async()=>{
  const color=$('settings-profile-color')?.value;
  try{
    await apiCall('/api/users/profile',{method:'PUT',body:JSON.stringify({profileColor:color})});
    showToast('success','Salvo','Cor do perfil atualizada!');
    updateProfilePreview();
  }catch(e){ showToast('error','Erro',e.message); }
});

function updateProfilePreview(){
  if(!currentUser) return;
  $('preview-username').textContent=currentUser.username||'';
  $('preview-tag').textContent=currentUser.username+'#'+currentUser.id;
  $('preview-bio').textContent=currentUser.bio||'';
  $('settings-bio-input').value=currentUser.bio||'';
  $('settings-avatar-preview').innerHTML='<img src="'+getAvatarUrl(currentUser.avatarSeed)+'" alt="" style="width:100%;height:100%;object-fit:cover" '+avatarOnerror(currentUser.username)+'>';
  $('settings-avatar-preview').style.background=generateColor(currentUser.username||'');
  $('profile-avatar-large-preview').innerHTML='<img src="'+getAvatarUrl(currentUser.avatarSeed)+'" alt="" style="width:100%;height:100%;object-fit:cover" '+avatarOnerror(currentUser.username)+'>';
  $('profile-avatar-large-preview').style.background=generateColor(currentUser.username||'');
}

// Voice & Video settings
$('settings-mic-volume')?.addEventListener('input',e=>{ $('settings-mic-volume-val').textContent=e.target.value+'%'; });
$('settings-speaker-volume')?.addEventListener('input',e=>{ $('settings-speaker-volume-val').textContent=e.target.value+'%'; });

let micTestStream=null, micTestInterval=null;
$('settings-mic-test-btn')?.addEventListener('click',async()=>{
  if(micTestStream){
    micTestStream.getTracks().forEach(t=>t.stop());
    micTestStream=null;
    clearInterval(micTestInterval);
    $('settings-mic-bars').style.display='none';
    $('settings-mic-test-btn').textContent='🎤 Iniciar teste';
    return;
  }
  try{
    micTestStream=await navigator.mediaDevices.getUserMedia({audio:true});
    $('settings-mic-bars').style.display='flex';
    $('settings-mic-test-btn').textContent='⏹ Parar teste';
    const ctx=new AudioContext();
    const src=ctx.createMediaStreamSource(micTestStream);
    const analyser=ctx.createAnalyser();
    analyser.fftSize=64;
    src.connect(analyser);
    const data=new Uint8Array(analyser.frequencyBinCount);
    const bars=$('settings-mic-bars').querySelectorAll('.mic-bar');
    micTestInterval=setInterval(()=>{
      analyser.getByteFrequencyData(data);
      const avg=data.reduce((a,b)=>a+b,0)/data.length;
      bars.forEach((bar,i)=>{
        const h=Math.max(4,Math.min(24,(avg/255)*24*(1-Math.abs(i-bars.length/2)/(bars.length/2))));
        bar.style.height=h+'px';
      });
    },50);
  }catch(e){ showToast('error','Erro','Permissão de microfone negada'); }
});

// Enumerate devices
async function loadAudioDevices(){
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    const mics=devices.filter(d=>d.kind==='audioinput');
    const speakers=devices.filter(d=>d.kind==='audiooutput');
    const micSelect=$('settings-mic-select');
    const spkSelect=$('settings-speaker-select');
    if(micSelect){ micSelect.innerHTML=''; mics.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Microfone '+(micSelect.options.length+1); micSelect.appendChild(o); }); }
    if(spkSelect){ spkSelect.innerHTML=''; speakers.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||'Alto-falante '+(spkSelect.options.length+1); spkSelect.appendChild(o); }); }
  }catch(e){}
}

// Font size
$('settings-font-size')?.addEventListener('input',e=>{
  $('settings-font-size-val').textContent=e.target.value+'px';
  document.documentElement.style.fontSize=e.target.value+'px';
});

// Appearance themes
document.querySelectorAll('.theme-option').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.theme-option').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
  });
});

$('home-btn')?.addEventListener('click',()=>{
  currentServer=null; currentServerId=null;
  currentChannel=null; currentChannelId=null;
  $('server-name-display').textContent='NexusChat';
  $('channels-list').innerHTML='<div class="empty-state"><div class="empty-icon">🏠</div><h3>Selecione um servidor</h3></div>';
  $('channel-name-display').textContent='';
  $('messages-list').innerHTML='';
  renderServers();
});

// ─── Members ───────────────────────────────────────────────────────────────

async function loadMembers(serverId){
  if(!serverId) return;
  try{
    const d=await apiCall('/api/servers/'+serverId+'/members');
    renderMembers(d.members||[]);
  }catch(e){ console.error('loadMembers',e); }
}

function renderMembers(members){
  const panel=$('members-panel');
  if(!panel) return;
  const online=members.filter(m=>m.status!=='offline');
  const offline=members.filter(m=>m.status==='offline');

  let html='';
  if(online.length>0){
    html+='<div class="members-category"><div class="members-category-header">Online — '+online.length+'</div>';
    online.forEach(m=>{
      html+=renderMemberCard(m);
    });
    html+='</div>';
  }
  if(offline.length>0){
    html+='<div class="members-category"><div class="members-category-header">Offline — '+offline.length+'</div>';
    offline.forEach(m=>{
      html+=renderMemberCard(m,true);
    });
    html+='</div>';
  }
  panel.innerHTML=html;
}

function renderMemberCard(m,isOffline=false){
  const name=m.nickname||m.username;
  const roleBadge=m.role&&m.role!=='member'?'<span class="role-badge" style="background:'+generateColor(m.role)+'">'+m.role+'</span>':'';
  return '<div class="member-card'+(isOffline?' offline':'')+'" data-user-id="'+m.id+'" onclick="window._showProfile('+m.id+',\''+escapeHtml(name)+'\',\''+(m.avatar_seed||'')+'\')">'+
    '<div class="member-avatar" style="background:'+generateColor(name)+'"><img src="'+getAvatarUrl(m.avatar_seed)+'" alt="" '+avatarOnerror(name)+'><span class="member-status status-dot '+(m.status||'offline')+'"></span></div>'+
    '<div class="member-info"><div class="member-name">'+escapeHtml(name)+' '+roleBadge+'</div>'+
    (m.custom_status?'<div class="member-game">'+escapeHtml(m.custom_status)+'</div>':'')+
    '</div></div>';
}

// ─── Voice ─────────────────────────────────────────────────────────────────

function getAudioCtx(){
  if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') audioCtx.resume();
  return audioCtx;
}

function setupLocalAnalyser(){
  if(!localStream) return;
  const ctx=getAudioCtx();
  const src=ctx.createMediaStreamSource(localStream);
  const analyser=ctx.createAnalyser();
  analyser.fftSize=512;
  src.connect(analyser);
  localAnalyser=analyser;
  localAnalyserData=new Uint8Array(analyser.frequencyBinCount);
}

function startSpeakingDetection(){
  if(speakingCheckInterval) clearInterval(speakingCheckInterval);
  speakingCheckInterval=setInterval(()=>{
    checkLocalSpeaking();
    Object.keys(peers).forEach(sid=>{
      if(peers[sid]?.analyser) checkRemoteSpeaking(sid,peers[sid].analyser);
    });
  },300);
}

function checkLocalSpeaking(){
  if(!localAnalyser||!localAnalyserData||isMuted){
    setSpeakingState('local',false);
    if(socket?.id) setSpeakingState(socket.id,false);
    return;
  }
  localAnalyser.getByteFrequencyData(localAnalyserData);
  let sum=0;
  for(let i=0;i<localAnalyserData.length;i++) sum+=localAnalyserData[i];
  const avg=sum/localAnalyserData.length;
  const speaking=avg>20;
  setSpeakingState('local',speaking);
  if(socket?.id) setSpeakingState(socket.id,speaking);
}

function checkRemoteSpeaking(sid,analyser){
  if(!analyser) return;
  const data=new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  let sum=0;
  for(let i=0;i<data.length;i++) sum+=data[i];
  const avg=sum/data.length;
  setSpeakingState(sid,avg>20);
}

function setSpeakingState(sid,speaking){
  const card=document.querySelector('[data-voice-socket="'+sid+'"]');
  if(card){
    card.classList.toggle('speaking',speaking);
    if(speaking) card.style.boxShadow='0 0 0 2px #22c55e';
    else card.style.boxShadow='';
  }
  document.querySelectorAll('.voice-user').forEach(el=>{
    if(el.dataset.socketId===sid){
      el.classList.toggle('speaking',speaking);
      if(speaking) el.style.color='#22c55e';
      else el.style.color='';
    }
  });
}

async function joinVoiceChannel(ch){
  if(!socket||!ch) return;
  try{
    localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    if(localStream.getAudioTracks()[0]){
      localStream.getAudioTracks()[0].enabled=!isMuted;
    }
    setupLocalAnalyser();
    socket.emit('join-voice',{channelId:ch.id,serverId:currentServerId});
    if(!speakingCheckInterval) startSpeakingDetection();
    $('voice-mute-btn')?.classList.remove('active');
    $('voice-deafen-btn')?.classList.remove('active');
  }catch(e){
    showToast('error','Erro','Não foi possível acessar o microfone');
  }
}

function cleanupVoice(){
  currentVoiceChannelId=null;
  isMuted=false;
  isDeafened=false;
  isScreenSharing=false;
  isCameraOn=false;
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  if(screenStream){ screenStream.getTracks().forEach(t=>t.stop()); screenStream=null; }
  if(cameraStream){ cameraStream.getTracks().forEach(t=>t.stop()); cameraStream=null; }
  Object.keys(peers).forEach(sid=>removePeer(sid));
  peers={};
  if(speakingCheckInterval){ clearInterval(speakingCheckInterval); speakingCheckInterval=null; }
  if(waveformInterval){ clearInterval(waveformInterval); waveformInterval=null; }
  localAnalyser=null;
  localAnalyserData=null;
  $('voice-connected-panel')?.classList.add('hidden');
  $('voice-video-btn')?.classList.remove('active');
  $('voice-share-btn')?.classList.remove('active');
  $('video-grid').innerHTML='';
  document.querySelectorAll('.voice-channel-item').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('[id^="voice-users-"]').forEach(div=>div.innerHTML='');
  voiceUsersMap={};
}

// ─── Waveform Animation ──────────────────────────────────────────────────

let waveformInterval=null;

function initWaveform(){
  const container=$('voice-waveform');
  if(!container) return;
  container.innerHTML='';
  for(let i=0;i<20;i++){
    const bar=document.createElement('div');
    bar.style.cssText='width:3px;border-radius:1.5px;background:var(--success);transition:height 0.1s ease;';
    bar.style.height='2px';
    container.appendChild(bar);
  }
  if(waveformInterval) clearInterval(waveformInterval);
  waveformInterval=setInterval(()=>{
    const bars=container.querySelectorAll('div');
    bars.forEach(bar=>{
      const h=localAnalyser?Math.max(2,Math.random()*16):Math.max(2,Math.random()*4);
      bar.style.height=h+'px';
    });
  },80);
}

async function createPeerConnection(socketId,userId,username,avatarSeed,isInitiator){
  if(peers[socketId]) return;
  const pc=new RTCPeerConnection(ICE_SERVERS);
  peers[socketId]={pc,userId,username,avatarSeed,analyser:null,isMuted:false,isScreenSharing:false};

  if(localStream){
    localStream.getTracks().forEach(track=>pc.addTrack(track,localStream));
  }

  const remoteStream=new MediaStream();
  pc.ontrack=e=>{
    const track=e.track;
    const stream=e.streams[0];
    if(track.kind==='video'){
      let videoEl=document.querySelector('[data-voice-socket="'+socketId+'"] video');
      if(!videoEl){
        const card=document.querySelector('[data-voice-socket="'+socketId+'"]');
        if(card){
          videoEl=document.createElement('video');
          videoEl.autoplay=true;
          videoEl.playsInline=true;
          videoEl.muted=true;
          videoEl.style.cssText='width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md)';
          card.prepend(videoEl);
          if(!card.querySelector('.video-fullscreen-btn')){
            const fsBtn=document.createElement('button');
            fsBtn.className='video-fullscreen-btn';
            fsBtn.title='Tela cheia';
            fsBtn.innerHTML='⛶';
            fsBtn.addEventListener('click',ev=>{
              ev.stopPropagation();
              const name=card.querySelector('.video-name')?.textContent||'Remoto';
              openFullscreen(videoEl,name);
            });
            card.appendChild(fsBtn);
          }
        }
      }
      if(videoEl&&stream){
        videoEl.srcObject=stream;
        videoEl.play().catch(()=>{});
      }
    }
    if(track.kind==='audio'){
      let audioEl=document.querySelector('[data-voice-socket="'+socketId+'"] audio');
      if(!audioEl){
        audioEl=document.createElement('audio');
        const card=document.querySelector('[data-voice-socket="'+socketId+'"]');
        if(card) card.appendChild(audioEl);
      }
      if(stream){
        audioEl.srcObject=stream;
        audioEl.play().catch(()=>{});
      }
    }

    if(stream&&!peers[socketId].analyser){
      try{
        const ctx=getAudioCtx();
        if(ctx.state==='suspended') ctx.resume();
        const src=ctx.createMediaStreamSource(stream);
        const analyser=ctx.createAnalyser();
        analyser.fftSize=512;
        src.connect(analyser);
        peers[socketId].analyser=analyser;
      }catch(e){}
    }
    }
  };

  pc.onicecandidate=e=>{
    if(e.candidate) socket?.emit('ice-candidate',{candidate:e.candidate,targetSocketId:socketId});
  };

  pc.onconnectionstatechange=()=>{
    if(pc.connectionState==='failed'||pc.connectionState==='disconnected'){
      removePeer(socketId);
    }
  };

  addParticipantCard(socketId,username,avatarSeed,true);

  if(isInitiator){
    try{
      const offer=await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit('voice-offer',{offer,targetSocketId:socketId});
    }catch(e){ console.error('createOffer error',e); }
  }
}

function removePeer(socketId){
  const peer=peers[socketId];
  if(peer){
    if(peer.pc) peer.pc.close();
    delete peers[socketId];
  }
  removeParticipantCard(socketId);
}

function addParticipantCard(socketId,username,avatarSeed,isLocal){
  if(socketId==='local') return;
  if(document.querySelector('[data-voice-socket="'+socketId+'"]')) return;
  const grid=$('video-grid');
  if(!grid) return;
  const card=document.createElement('div');
  card.className='video-tile';
  card.dataset.voiceSocket=socketId;
  card.innerHTML='<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-surface);border-radius:var(--radius-md)"><img src="'+getAvatarUrl(avatarSeed)+'" style="width:48px;height:48px;border-radius:50%" alt="" '+avatarOnerror(username)+'></div><span class="video-name">'+escapeHtml(username)+'</span>';
  grid.appendChild(card);
}

function removeParticipantCard(socketId){
  const card=document.querySelector('[data-voice-socket="'+socketId+'"]');
  if(card) card.remove();
}

function addLocalScreenCard(stream){
  const grid=$('video-grid');
  if(!grid) return;
  const existing=document.querySelector('[data-voice-socket="local-screen"]');
  if(existing) existing.remove();
  const card=document.createElement('div');
  card.className='video-tile';
  card.dataset.voiceSocket='local-screen';
  const video=document.createElement('video');
  video.autoplay=true; video.playsInline=true; video.muted=true;
  video.style.cssText='width:100%;height:100%;object-fit:contain;border-radius:var(--radius-md)';
  video.srcObject=stream;
  card.appendChild(video);
  const badge=document.createElement('span');
  badge.className='live-badge';
  badge.textContent='AO VIVO';
  card.appendChild(badge);
  const label=document.createElement('span');
  label.className='video-name';
  label.textContent='Sua Tela';
  card.appendChild(label);
  const fsBtn=document.createElement('button');
  fsBtn.className='video-fullscreen-btn';
  fsBtn.title='Tela cheia';
  fsBtn.innerHTML='⛶';
  fsBtn.addEventListener('click',e=>{
    e.stopPropagation();
    openFullscreen(video,'Sua Tela');
  });
  card.appendChild(fsBtn);
  grid.appendChild(card);
}

$('voice-mute-btn')?.addEventListener('click',toggleMute);
$('mute-btn')?.addEventListener('click',toggleMute);

function toggleMute(){
  if(!localStream) return;
  isMuted=!isMuted;
  localStream.getAudioTracks().forEach(t=>t.enabled=!isMuted);
  $('voice-mute-btn')?.classList.toggle('active',isMuted);
  $('mute-btn')?.classList.toggle('active',isMuted);
  socket?.emit('voice-mute',{isMuted});
}

$('voice-deafen-btn')?.addEventListener('click',toggleDeafen);
$('deafen-btn')?.addEventListener('click',toggleDeafen);

function toggleDeafen(){
  isDeafened=!isDeafened;
  if(isDeafened&&!isMuted) toggleMute();
  if(localStream) localStream.getAudioTracks().forEach(t=>t.enabled=!isDeafened);
  $('voice-deafen-btn')?.classList.toggle('active',isDeafened);
  $('deafen-btn')?.classList.toggle('active',isDeafened);
  Object.values(peers).forEach(p=>{
    if(p.pc){
      p.pc.getReceivers().forEach(r=>{ if(r.track?.kind==='audio') r.track.enabled=!isDeafened; });
    }
  });
}

$('voice-disconnect-btn')?.addEventListener('click',()=>{
  socket?.emit('leave-voice');
  cleanupVoice();
});

$('voice-video-btn')?.addEventListener('click',async()=>{
  if(!currentVoiceChannelId) return;
  if(isScreenSharing){ stopScreenShare(); return; }
  try{
    screenStream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
    isScreenSharing=true;
    screenStream.getVideoTracks()[0].onended=()=>{ stopScreenShare(); };

    const screenAudioTrack=screenStream.getAudioTracks()[0]||null;

    for(const [sid,peer] of Object.entries(peers)){
      if(!peer.pc) continue;
      const transceivers=peer.pc.getTransceivers();
      const videoTransceiver=transceivers.find(t=>t.kind==='video');
      const videoSender=videoTransceiver?.sender;
      if(videoSender) await videoSender.replaceTrack(screenStream.getVideoTracks()[0]);
      else peer.pc.addTrack(screenStream.getVideoTracks()[0],screenStream);

      if(screenAudioTrack){
        const audioTransceiver=transceivers.find(t=>t.kind==='audio');
        const audioSender=audioTransceiver?.sender;
        if(audioSender) await audioSender.replaceTrack(screenAudioTrack);
      }

      try{
        const offer=await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        socket?.emit('voice-offer',{offer,targetSocketId:sid});
      }catch(e){}
    }
    socket?.emit('screen-share-started');
    $('voice-video-btn')?.classList.add('active');
    $('voice-share-btn')?.classList.add('active');
    addLocalScreenCard(screenStream);
    const hasAudio=screenStream.getAudioTracks().length>0;
    showToast('info','Screen Share',hasAudio?'Compartilhamento com áudio iniciado':'Compartilhamento iniciado');
  }catch(e){ console.error('screen share error',e); }
});

$('voice-share-btn')?.addEventListener('click',()=>$('voice-video-btn')?.click());

function stopScreenShare(){
  isScreenSharing=false;
  if(screenStream){ screenStream.getTracks().forEach(t=>t.stop()); screenStream=null; }
  const localCard=document.querySelector('[data-voice-socket="local-screen"]');
  if(localCard) localCard.remove();

  for(const [sid,peer] of Object.entries(peers)){
    if(!peer.pc) continue;
    const transceivers=peer.pc.getTransceivers();
    const videoTransceiver=transceivers.find(t=>t.kind==='video');
    const videoSender=videoTransceiver?.sender;
    if(isCameraOn&&cameraStream){
      if(videoSender) videoSender.replaceTrack(cameraStream.getVideoTracks()[0]);
      else peer.pc.addTrack(cameraStream.getVideoTracks()[0],cameraStream);
    } else {
      if(videoSender) videoSender.replaceTrack(null);
    }

    if(localStream){
      const micTrack=localStream.getAudioTracks()[0];
      if(micTrack){
        const audioTransceiver=transceivers.find(t=>t.kind==='audio');
        const audioSender=audioTransceiver?.sender;
        if(audioSender) audioSender.replaceTrack(micTrack);
      }
    }

    try{
      peer.pc.createOffer().then(offer=>peer.pc.setLocalDescription(offer).then(()=>{
        socket?.emit('voice-offer',{offer,targetSocketId:sid});
      }));
    }catch(e){}
  }
  socket?.emit('screen-share-stopped');
  $('voice-video-btn')?.classList.remove('active');
  $('voice-share-btn')?.classList.remove('active');
}

async function toggleCamera(){
  if(!currentVoiceChannelId) return;
  if(isCameraOn){
    isCameraOn=false;
    if(cameraStream){ cameraStream.getTracks().forEach(t=>t.stop()); cameraStream=null; }
    for(const [sid,peer] of Object.entries(peers)){
      if(!peer.pc) continue;
      const tcv=peer.pc.getTransceivers().find(t=>t.kind==='video');
      if(tcv?.sender) tcv.sender.replaceTrack(null);
    }
    socket?.emit('camera-stopped');
    return;
  }
  try{
    cameraStream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
    isCameraOn=true;
    for(const [sid,peer] of Object.entries(peers)){
      if(!peer.pc) continue;
      const tcv=peer.pc.getTransceivers().find(t=>t.kind==='video');
      if(tcv?.sender) await tcv.sender.replaceTrack(cameraStream.getVideoTracks()[0]);
      else peer.pc.addTrack(cameraStream.getVideoTracks()[0],cameraStream);
    }
    socket?.emit('camera-started');
  }catch(e){ console.error('camera error',e); }
}

// ─── Voice Users UI ────────────────────────────────────────────────────────

function updateVoiceUsersList(users){
  if(!users) return;
  users.forEach(u=>{
    const existing=document.querySelector('[data-voice-socket="'+u.socketId+'"]');
    if(!existing) addParticipantCard(u.socketId,u.username,u.avatarSeed,false);
  });
}

function updateVoiceChannelUsersUI(){
  document.querySelectorAll('.voice-channel-item').forEach(el=>{
    el.classList.toggle('active',el.dataset.channelId==currentVoiceChannelId);
  });
  const users=Object.values(voiceUsersMap||{});
  document.querySelectorAll('[id^="voice-users-"]').forEach(div=>{
    div.innerHTML='';
  });
  users.forEach(u=>{
    const container=document.getElementById('voice-users-'+u.channelId);
    if(!container) return;
    const d=document.createElement('div');
    d.className='voice-user';
    d.dataset.socketId=u.socketId||'';
    const live=u.isScreenSharing?' <span style="color:#ef4444;font-size:0.65rem;font-weight:700;margin-left:4px">AO VIVO</span>':'';
    const now=new Date();
    const ts=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0')+':'+now.getSeconds().toString().padStart(2,'0');
    d.innerHTML='<div class="voice-avatar"><img src="'+getAvatarUrl(u.avatarSeed)+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%;image-rendering:crisp-edges" alt="" '+avatarOnerror(u.username)+'></div><span>'+escapeHtml(u.username)+live+'</span><span class="voice-time">'+ts+'</span>';
    container.appendChild(d);
  });
}

function getChannelNameById(channelId){
  if(!currentServer||!currentServer.channels) return 'Canal de Voz';
  const ch=currentServer.channels.find(c=>c.id==channelId||c.id===channelId);
  return ch?ch.name:'Canal de Voz';
}

// ─── Sound Effects ─────────────────────────────────────────────────────────

function playSound(type){
  try{
    const ctx=getAudioCtx();
    const osc=ctx.createOscillator();
    const gain=ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value=0.1;

    if(type==='join'||type==='message'){
      osc.frequency.value=880;
      osc.type='sine';
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime+0.1);
    } else if(type==='leave'){
      osc.frequency.value=440;
      osc.type='sine';
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime+0.15);
    } else {
      osc.frequency.value=660;
      osc.type='sine';
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime+0.08);
    }
  }catch(e){}
}

// ─── Infinite Scroll ───────────────────────────────────────────────────────

function setupInfiniteScroll(){
  const container=$('messages-container');
  const trigger=$('load-more-trigger');
  if(!container||!trigger) return;

  const obs=new IntersectionObserver(entries=>{
    if(entries[0].isIntersecting&&hasMoreMessages&&!isLoadingMessages&&currentChannelId){
      const firstMsg=document.querySelector('[data-msg-id]');
      const beforeId=firstMsg?firstMsg.dataset.msgId:null;
      if(beforeId) loadMessages(currentChannelId,beforeId);
    }
  },{root:container,threshold:0.1});
  obs.observe(trigger);
}

// ─── Toggle Members Panel ──────────────────────────────────────────────────

$('toggle-members-btn')?.addEventListener('click',()=>{
  const panel=$('members-panel');
  if(!panel) return;
  membersVisible=!membersVisible;
  panel.style.display=membersVisible?'':'none';
  $('toggle-members-btn')?.classList.toggle('active',membersVisible);
});

// ─── Mobile Sidebar Toggle ─────────────────────────────────────────────────

$('channel-sidebar')?.addEventListener('click',e=>{
  if(window.innerWidth<=768){
    const sidebar=$('channel-sidebar');
    if(e.target===sidebar) sidebar.classList.remove('open');
  }
});

// ─── Fullscreen Overlay ─────────────────────────────────────────────────────

function openFullscreen(videoEl,label){
  const overlay=$('fullscreen-overlay');
  const fsLabel=$('fs-label');
  if(!overlay||!videoEl) return;
  const clone=videoEl.cloneNode(true);
  clone.muted=false;
  clone.srcObject=videoEl.srcObject;
  clone.style.cssText='width:100%;height:100%;object-fit:contain';
  overlay.innerHTML='';
  const closeBtn=document.createElement('button');
  closeBtn.className='fs-close';
  closeBtn.title='Fechar tela cheia';
  closeBtn.innerHTML='✕';
  closeBtn.addEventListener('click',closeFullscreen);
  overlay.appendChild(closeBtn);
  const badge=document.createElement('div');
  badge.className='fs-badge';
  badge.textContent='AO VIVO';
  overlay.appendChild(badge);
  if(label){
    const lbl=document.createElement('div');
    lbl.className='fs-label';
    lbl.textContent=label;
    overlay.appendChild(lbl);
  }
  overlay.appendChild(clone);
  overlay.classList.add('active');
  try{ overlay.requestFullscreen?.(); }catch(e){}
}

function closeFullscreen(){
  const overlay=$('fullscreen-overlay');
  if(overlay){
    overlay.classList.remove('active');
    overlay.innerHTML='';
  }
  try{ document.exitFullscreen?.(); }catch(e){}
}

document.addEventListener('keydown',e=>{
  if(e.key==='Escape') closeFullscreen();
});

// ─── Init ──────────────────────────────────────────────────────────────────

checkAuth();

})();
