
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  getSoporteUsers, 
  getChannelsByAgent, 
  getUnassignedChannels, 
  getMessages, 
  assignAgentToChannel,
  sendMessage,
  uploadAudioFile,
  getAllUsers
} from './firebase';
import { User, Channel, Message } from './types';
import { analyzeConversation, suggestReply } from './geminiService';

// --- Utils ---

const safeNewDate = (dateStr: string | number) => {
  if (!dateStr) return new Date();
  if (typeof dateStr === 'string' && /^\d+$/.test(dateStr)) {
    return new Date(Number(dateStr));
  }
  if (dateStr && typeof (dateStr as any).toMillis === 'function') {
    return new Date((dateStr as any).toMillis());
  }
  return new Date(dateStr);
};

const isSameDay = (d1: Date, d2: Date) => {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
};

const formatDateSeparator = (date: Date) => {
  const now = new Date();
  if (isSameDay(date, now)) return "Hoy";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return "Ayer";
  
  return date.toLocaleDateString('es-ES', { 
    day: 'numeric', 
    month: 'long', 
    year: 'numeric' 
  });
};

const formatTimeOnly = (date: Date) => {
  return date.toLocaleTimeString('es-ES', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit' 
  });
};

const formatFriendlyDate = (dateStr: string) => {
  if (!dateStr) return 'Reciente';
  const date = safeNewDate(dateStr);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) return formatTimeOnly(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Ayer';
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
};

// --- Components ---

const ChatBubble: React.FC<{ message: Message; isMe: boolean }> = ({ message, isMe }) => {
  const date = safeNewDate(message.timestamp);
  const isAudio = message.tipo === 'audio' || (message.resurl && message.resurl.length > 0);
  
  return (
    <div className={`flex flex-col mb-4 ${isMe ? 'items-end' : 'items-start animate-fade-in-left'}`}>
      <div className={`max-w-[85%] sm:max-w-[70%] p-3.5 rounded-2xl shadow-sm relative ${
        isMe 
          ? 'bg-indigo-600 text-white rounded-tr-none' 
          : 'bg-white text-gray-800 rounded-tl-none border border-gray-100'
      }`}>
        {isAudio ? (
          <div className="flex flex-col space-y-2 min-w-[220px]">
            {message.mensaje && <p className="text-sm mb-1">{message.mensaje}</p>}
            <div className={`flex items-center rounded-xl p-2 ${isMe ? 'bg-indigo-500' : 'bg-gray-50'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center mr-3 flex-shrink-0 ${isMe ? 'bg-indigo-400' : 'bg-indigo-100 text-indigo-600'}`}>
                <i className="fa-solid fa-play text-xs"></i>
              </div>
              <audio controls src={message.resurl} className="h-8 w-full filter brightness-95 opacity-80" />
            </div>
          </div>
        ) : (
          <p className="text-sm leading-relaxed">{message.mensaje}</p>
        )}
      </div>
      <div className="flex items-center mt-1 px-1 space-x-1">
        <span className="text-[10px] text-gray-400 font-medium">{formatTimeOnly(date)}</span>
        {isMe && (
          <i className={`fa-solid fa-check-double text-[10px] ${message.leido ? 'text-indigo-400' : 'text-gray-300'}`}></i>
        )}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  // Master Password State
  const [isMasterAuthenticated, setIsMasterAuthenticated] = useState(() => {
    return sessionStorage.getItem('master_auth') === 'true';
  });
  const [masterPassInput, setMasterPassInput] = useState('');
  const [masterError, setMasterError] = useState(false);

  // Data States
  const [agents, setAgents] = useState<User[]>([]);
  const [usersMap, setUsersMap] = useState<Record<string, User>>({});
  const [selectedAgent, setSelectedAgent] = useState<User | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [unassignedChannels, setUnassignedChannels] = useState<Channel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  
  // UI States
  const [newMessage, setNewMessage] = useState('');
  const [viewUnassigned, setViewUnassigned] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Auth States
  const [authPendingAgent, setAuthPendingAgent] = useState<User | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState(false);

  // Audio States
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Filtrado de tickets por tipo de agente
  const filteredUnassigned = useMemo(() => {
    if (!selectedAgent) return [];
    const technicalSupportCode = 'Ms9w06Xk68Rb4QdVx4WH';
    
    if (selectedAgent.tipo === 'soporteTecnico') {
      // Soporte técnico solo ve el canal específico
      return unassignedChannels.filter(ch => ch.id === technicalSupportCode);
    } else {
      // Soporte general ve todos los demás
      return unassignedChannels.filter(ch => ch.id !== technicalSupportCode);
    }
  }, [unassignedChannels, selectedAgent]);

  // Helper to get partner name (Client)
  const getPartnerName = (channel: Channel) => {
    if (!channel) return "Desconocido";
    if (usersMap[channel.id]) return usersMap[channel.id].nombre;
    if (!channel.usuarios || channel.usuarios.length === 0) {
      return `Cliente #${channel.id.slice(-5)}`;
    }
    const partnerId = selectedAgent 
      ? (channel.usuarios.find(id => id !== selectedAgent.id && id !== 'npQOEYLQPkNw5GXpvyLl') || channel.usuarios[0])
      : channel.usuarios.find(id => id !== 'npQOEYLQPkNw5GXpvyLl') || channel.usuarios[0];
    
    if (usersMap[partnerId]) return usersMap[partnerId].nombre;
    return `Cliente #${partnerId.slice(-5)}`;
  };

  const getPartnerImage = (channel: Channel) => {
    if (!channel || !channel.usuarios) return null;
    const partnerId = channel.usuarios.find(id => id !== selectedAgent?.id && id !== 'npQOEYLQPkNw5GXpvyLl') || channel.usuarios[0];
    return partnerId ? usersMap[partnerId]?.image_url : null;
  };

  // Initial Load
  useEffect(() => {
    if (!isMasterAuthenticated) return;
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    const unsubAgents = getSoporteUsers(setAgents);
    const unsubUnassigned = getUnassignedChannels(setUnassignedChannels);
    const unsubUsers = getAllUsers(setUsersMap);
    
    return () => { 
      window.removeEventListener('resize', handleResize);
      unsubAgents(); 
      unsubUnassigned();
      unsubUsers();
    };
  }, [isMasterAuthenticated]);

  // Real-time Data Sync
  useEffect(() => {
    if (!selectedAgent) return;
    const unsub = getChannelsByAgent(selectedAgent.id, (data) => {
      const sortedChannels = [...data].sort((a, b) => {
        const timeA = Number(a.updated) || 0;
        const timeB = Number(b.updated) || 0;
        return timeB - timeA;
      });
      setChannels(sortedChannels);
    });
    return () => unsub();
  }, [selectedAgent]);

  useEffect(() => {
    if (!selectedChannel) return;
    const unsub = getMessages(selectedChannel.id, setMessages);
    return () => unsub();
  }, [selectedChannel]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, aiSummary]);

  // Handlers
  const handleMasterAuth = (e: React.FormEvent) => {
    e.preventDefault();
    if (masterPassInput === '123456') {
      setIsMasterAuthenticated(true);
      sessionStorage.setItem('master_auth', 'true');
    } else {
      setMasterError(true);
      setMasterPassInput('');
    }
  };

  const handleAuth = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authPendingAgent) return;
    const validPass = authPendingAgent.password || '123456';
    if (passwordInput === validPass) {
      setSelectedAgent(authPendingAgent);
      setAuthPendingAgent(null);
      setPasswordInput('');
      setAuthError(false);
    } else {
      setAuthError(true);
      setPasswordInput('');
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/mp4' });
        await handleSendAudio(audioBlob);
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = window.setInterval(() => setRecordingTime(p => p + 1), 1000);
    } catch (err) {
      alert("Permiso de micrófono denegado.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const handleSendAudio = async (blob: Blob) => {
    if (!selectedChannel || !selectedAgent) return;
    setIsUploading(true);
    try {
      const ts = Date.now();
      const fileName = `audio_${ts}.mp4`;
      const url = await uploadAudioFile(blob, fileName);
      await sendMessage(selectedChannel.id, selectedAgent.id, '', url, fileName, 'audio');
    } catch (error) {
      console.error(error);
      alert("Error al subir audio.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleSendMessage = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (newMessage.trim() && selectedChannel && selectedAgent) {
      sendMessage(selectedChannel.id, selectedAgent.id, newMessage);
      setNewMessage('');
    }
  };

  // Master Authentication Screen
  if (!isMasterAuthenticated) {
    return (
      <div className="fixed inset-0 bg-gradient-to-br from-indigo-900 via-slate-900 to-black flex items-center justify-center p-6 z-[999]">
        <div className="bg-white/10 backdrop-blur-xl p-10 rounded-[3rem] border border-white/10 w-full max-w-md shadow-2xl flex flex-col items-center">
          <div className="w-20 h-20 bg-indigo-600 rounded-[2rem] flex items-center justify-center mb-8 shadow-xl shadow-indigo-500/20">
            <i className="fa-solid fa-lock text-3xl text-white"></i>
          </div>
          <h1 className="text-2xl font-black text-white mb-2 tracking-tighter">ACCESO RESTRINGIDO</h1>
          <p className="text-indigo-200/60 text-xs font-bold uppercase tracking-widest mb-8 text-center">Introduce el código maestro para continuar</p>
          
          <form onSubmit={handleMasterAuth} className="w-full space-y-4">
            <input 
              autoFocus
              type="password"
              value={masterPassInput}
              onChange={(e) => { setMasterPassInput(e.target.value); setMasterError(false); }}
              placeholder="••••••"
              className={`w-full bg-white/5 border-2 rounded-2xl px-6 py-4 text-center font-black text-3xl tracking-[0.5em] text-white focus:outline-none transition-all ${
                masterError ? 'border-red-500 animate-shake' : 'border-white/10 focus:border-indigo-500'
              }`}
            />
            <button 
              type="submit"
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-black py-4 rounded-2xl transition-all uppercase tracking-widest text-xs shadow-lg shadow-indigo-500/20 active:scale-95"
            >
              Desbloquear Sistema
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Mobile Views Logic
  const showChatMobile = isMobile && selectedChannel && !viewUnassigned;
  const showChannelsMobile = isMobile && selectedAgent && !selectedChannel && !viewUnassigned;
  const showAgentsMobile = isMobile && !selectedAgent && !viewUnassigned;

  return (
    <div className="flex h-[100svh] w-full bg-gray-50 font-sans overflow-hidden select-none">
      
      {/* Column 1: Agentes */}
      {(showAgentsMobile || !isMobile) && (
        <aside className={`${isMobile ? 'w-full' : 'w-20 lg:w-72'} bg-white border-r border-gray-100 flex flex-col transition-all duration-300 z-10`}>
          <div className="p-6 h-20 flex items-center border-b border-gray-50">
            <h1 className="text-xl font-black text-indigo-600 flex items-center tracking-tighter">
              <i className="fa-solid fa-shield-halved mr-2"></i>
              <span className={`${!isMobile && 'hidden lg:inline'}`}>IVE DASH</span>
            </h1>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {!selectedAgent ? (
              <div className="space-y-4">
                <h2 className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em] mb-4 px-2">Operadores</h2>
                {agents.map(agent => (
                  <button
                    key={agent.id}
                    onClick={() => setAuthPendingAgent(agent)}
                    className="w-full flex items-center p-3 rounded-2xl hover:bg-indigo-50 transition-all group active:scale-95"
                  >
                    <img src={agent.image_url} className="w-11 h-11 rounded-2xl object-cover mr-3 shadow-sm border-2 border-transparent group-hover:border-indigo-200" alt="" />
                    <div className={`text-left overflow-hidden ${!isMobile && 'hidden lg:block'}`}>
                      <p className="font-bold text-gray-800 text-sm truncate">{agent.nombre}</p>
                      <p className="text-[10px] text-gray-400 uppercase font-black">{agent.tipo}</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-6">
                <div className={`p-4 bg-indigo-600 rounded-3xl text-white shadow-xl shadow-indigo-100 transition-all ${!isMobile && 'lg:p-6'}`}>
                  <div className="flex items-center mb-4">
                    <img src={selectedAgent.image_url} className="w-10 h-10 rounded-xl border-2 border-white/20 mr-3" alt="" />
                    <div className={`overflow-hidden ${!isMobile && 'hidden lg:block'}`}>
                      <p className="font-bold text-sm truncate">{selectedAgent.nombre}</p>
                      <p className="text-[10px] text-indigo-100 font-bold uppercase tracking-widest">En Línea</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => { setSelectedAgent(null); setSelectedChannel(null); }}
                    className="w-full py-2 bg-white/10 hover:bg-white/20 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all"
                  >
                    {isMobile || window.innerWidth > 1024 ? 'Cerrar Sesión' : <i className="fa-solid fa-right-from-bracket"></i>}
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>
      )}

      {/* Column 2: Canales */}
      {(showChannelsMobile || (!isMobile && selectedAgent)) && (
        <section className={`${isMobile ? 'w-full' : 'w-80'} bg-[#FDFDFD] border-r border-gray-100 flex flex-col animate-fade-in`}>
          <header className="h-20 border-b border-gray-50 px-6 flex items-center justify-between">
            <div className="flex items-center">
              {isMobile && (
                <button onClick={() => setSelectedAgent(null)} className="mr-3 text-gray-400 p-2"><i className="fa-solid fa-arrow-left"></i></button>
              )}
              <h3 className="font-black text-gray-800 text-xs uppercase tracking-widest">Canales Activos</h3>
            </div>
            <button 
              onClick={() => setViewUnassigned(!viewUnassigned)}
              className={`p-2.5 rounded-xl transition-all relative ${viewUnassigned ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-400 hover:text-indigo-600'}`}
            >
              <i className="fa-solid fa-bell-concierge"></i>
              {filteredUnassigned.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[9px] w-4 h-4 rounded-full flex items-center justify-center border-2 border-white animate-bounce">
                  {filteredUnassigned.length}
                </span>
              )}
            </button>
          </header>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
            {channels.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center opacity-20 p-8">
                <i className="fa-solid fa-inbox text-5xl mb-4"></i>
                <p className="font-black uppercase tracking-tighter">Sin chats activos</p>
              </div>
            ) : (
              channels.map(ch => (
                <button
                  key={ch.id}
                  onClick={() => setSelectedChannel(ch)}
                  className={`w-full text-left p-4 rounded-2xl transition-all border ${
                    selectedChannel?.id === ch.id 
                      ? 'bg-indigo-50 border-indigo-100 shadow-sm' 
                      : 'bg-white border-transparent hover:border-gray-100 hover:bg-gray-50/50'
                  }`}
                >
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[10px] font-black text-indigo-500 uppercase">#{ch.id.slice(-5)}</span>
                    <span className="text-[9px] text-gray-400 font-bold">{formatFriendlyDate(ch.updated)}</span>
                  </div>
                  <div className="flex items-center">
                    {getPartnerImage(ch) && (
                      <img src={getPartnerImage(ch)!} className="w-6 h-6 rounded-full mr-2 object-cover border border-gray-100" alt="" />
                    )}
                    <p className="text-sm font-bold text-gray-800 capitalize truncate">{getPartnerName(ch)}</p>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1 truncate">Motivo: {ch.tipo}</p>
                </button>
              ))
            )}
          </div>
        </section>
      )}

      {/* Column 3: Chat Main */}
      {(showChatMobile || !isMobile) && (
        <main className={`flex-1 flex flex-col bg-white relative ${isMobile && !selectedChannel ? 'hidden' : ''} animate-fade-in`}>
          {selectedChannel ? (
            <>
              <header className="h-20 border-b border-gray-100 px-4 sm:px-8 flex items-center justify-between z-10 bg-white/80 backdrop-blur-md sticky top-0">
                <div className="flex items-center overflow-hidden">
                  {isMobile && (
                    <button onClick={() => setSelectedChannel(null)} className="p-3 mr-2 text-gray-400 hover:text-indigo-600">
                      <i className="fa-solid fa-chevron-left text-lg"></i>
                    </button>
                  )}
                  {getPartnerImage(selectedChannel) ? (
                    <img src={getPartnerImage(selectedChannel)!} className="w-10 h-10 rounded-xl mr-3 flex-shrink-0 shadow-inner object-cover border border-gray-100" alt="" />
                  ) : (
                    <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center mr-3 flex-shrink-0 shadow-inner">
                      <i className="fa-solid fa-user"></i>
                    </div>
                  )}
                  <div className="overflow-hidden">
                    <h2 className="font-black text-gray-800 tracking-tight text-sm sm:text-base truncate">{getPartnerName(selectedChannel)}</h2>
                    <p className="text-[10px] text-green-500 font-black uppercase tracking-widest flex items-center">
                      <span className="w-1.5 h-1.5 bg-green-500 rounded-full mr-2 animate-pulse"></span> ONLINE
                    </p>
                  </div>
                </div>
                
                <div className="flex items-center space-x-2">
                  <button 
                    onClick={async () => {
                      setIsAnalyzing(true);
                      const res = await analyzeConversation(messages.map(m => `${m.origen}: ${m.mensaje}`));
                      setAiSummary(res);
                      setIsAnalyzing(false);
                    }}
                    disabled={isAnalyzing || messages.length === 0}
                    className="w-10 h-10 flex items-center justify-center bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-100 transition-all disabled:opacity-50"
                  >
                    <i className={`fa-solid ${isAnalyzing ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
                  </button>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto p-4 sm:p-8 bg-[#FDFDFD] scroll-smooth custom-scrollbar">
                {aiSummary && (
                  <div className="mb-8 p-5 bg-indigo-600 text-white rounded-[2rem] shadow-2xl shadow-indigo-100 relative animate-fade-in-down">
                    <button onClick={() => setAiSummary(null)} className="absolute top-4 right-4 text-white/40 hover:text-white">
                      <i className="fa-solid fa-circle-xmark"></i>
                    </button>
                    <div className="flex items-start">
                      <div className="bg-white/20 p-2.5 rounded-xl mr-4 flex-shrink-0">
                        <i className="fa-solid fa-robot text-sm"></i>
                      </div>
                      <p className="text-xs sm:text-sm leading-relaxed font-medium">{aiSummary}</p>
                    </div>
                  </div>
                )}

                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-30">
                    <i className="fa-solid fa-message-dots text-6xl mb-6 text-gray-200"></i>
                    <p className="font-black uppercase tracking-widest text-xs">Sin mensajes en este canal</p>
                  </div>
                ) : (
                  messages.map((m, index) => {
                    const date = safeNewDate(m.timestamp);
                    const prevMessage = messages[index - 1];
                    const prevDate = prevMessage ? safeNewDate(prevMessage.timestamp) : null;
                    const showSeparator = !prevDate || !isSameDay(date, prevDate);

                    return (
                      <React.Fragment key={m.id}>
                        {showSeparator && (
                          <div className="flex items-center justify-center my-10 relative">
                            <div className="absolute inset-0 flex items-center" aria-hidden="true">
                              <div className="w-full border-t border-gray-100"></div>
                            </div>
                            <div className="relative flex justify-center">
                              <span className="px-5 py-1.5 bg-gray-50 text-[9px] font-black uppercase tracking-[0.2em] text-gray-400 rounded-full border border-gray-100 shadow-sm backdrop-blur-sm">
                                {formatDateSeparator(date)}
                              </span>
                            </div>
                          </div>
                        )}
                        <ChatBubble message={m} isMe={m.origen === (selectedAgent?.id || '')} />
                      </React.Fragment>
                    );
                  })
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="p-4 sm:p-6 bg-white border-t border-gray-100">
                <div className="max-w-4xl mx-auto">
                  {isRecording ? (
                    <div className="flex items-center justify-between bg-red-50 p-4 rounded-3xl border-2 border-red-100 animate-pulse">
                      <div className="flex items-center text-red-600 font-black text-xs uppercase tracking-widest">
                        <span className="w-2.5 h-2.5 bg-red-600 rounded-full mr-3 animate-ping"></span>
                        REC: {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                      </div>
                      <button onClick={stopRecording} className="px-6 py-2 bg-red-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all">
                        Enviar
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleSendMessage} className="relative group">
                      <textarea 
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Responder al cliente..."
                        className="w-full bg-gray-50 border-2 border-transparent focus:border-indigo-100 focus:bg-white rounded-[1.5rem] px-5 py-4 pr-32 text-sm focus:outline-none transition-all resize-none min-h-[56px] max-h-40 shadow-inner custom-scrollbar"
                        onKeyDown={(e) => { 
                          if(e.key === 'Enter' && !e.shiftKey && !isMobile) { 
                            e.preventDefault(); 
                            handleSendMessage(); 
                          } 
                        }}
                      />
                      <div className="absolute right-3 bottom-3 flex space-x-2">
                        <button 
                          type="button" 
                          onClick={startRecording}
                          className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                        >
                          <i className="fa-solid fa-microphone"></i>
                        </button>
                        <button 
                          type="button" 
                          onClick={async () => {
                            const ctx = messages.slice(-4).map(m => m.mensaje).join(' | ');
                            const suggestion = await suggestReply(ctx);
                            if(suggestion) setNewMessage(suggestion);
                          }}
                          className="w-10 h-10 flex items-center justify-center text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
                        >
                          <i className="fa-solid fa-sparkles"></i>
                        </button>
                        <button 
                          type="submit"
                          disabled={!newMessage.trim() && !isUploading}
                          className="w-10 h-10 bg-indigo-600 text-white rounded-xl flex items-center justify-center shadow-lg shadow-indigo-100 hover:scale-105 active:scale-95 transition-all disabled:opacity-30"
                        >
                          <i className={`fa-solid ${isUploading ? 'fa-spinner fa-spin' : 'fa-paper-plane'} text-xs`}></i>
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 sm:p-12 bg-[#FAFAFA] relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 via-indigo-600 to-indigo-500"></div>
              
              <div className="w-32 h-32 bg-white rounded-[2.5rem] shadow-2xl shadow-indigo-100/50 flex items-center justify-center mb-10 rotate-3 hover:rotate-0 transition-all duration-500 group relative">
                <i className="fa-solid fa-headset text-5xl text-indigo-600 group-hover:scale-110 transition-transform"></i>
                {unassignedChannels.length > 0 && (
                  <div className="absolute -top-3 -right-3 w-10 h-10 bg-red-600 text-white rounded-full flex items-center justify-center text-sm font-black border-4 border-white animate-bounce shadow-lg">
                    {unassignedChannels.length}
                  </div>
                )}
              </div>
              
              <h3 className="text-2xl sm:text-3xl font-black text-gray-800 uppercase tracking-tighter mb-4">Bandeja de Atención</h3>
              
              <div className="bg-white/60 backdrop-blur-md border border-white p-6 rounded-[2rem] shadow-xl max-w-sm w-full transition-all hover:shadow-2xl hover:bg-white">
                <p className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.2em] mb-3">Estado del Sistema</p>
                {unassignedChannels.length > 0 ? (
                  <div className="flex flex-col items-center">
                    <p className="text-sm text-gray-600 font-medium leading-relaxed mb-4">
                      Hay <span className="text-indigo-600 font-black">{unassignedChannels.length}</span> tickets esperando ser atendidos.
                    </p>
                    <button 
                      onClick={() => setViewUnassigned(true)}
                      className="px-6 py-2.5 bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-indigo-700 transition-all active:scale-95"
                    >
                      Ver Tickets Pendientes
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 font-medium leading-relaxed">
                    ¡Gran trabajo! No hay tickets pendientes en este momento.
                  </p>
                )}
              </div>
              
              <p className="max-w-xs text-[10px] mt-8 text-gray-300 font-bold uppercase tracking-widest">
                Selecciona una conversación activa para comenzar
              </p>
            </div>
          )}
        </main>
      )}

      {/* Overlay Screens (Unassigned, Auth) */}
      {viewUnassigned && (
        <div className={`fixed inset-0 z-40 flex flex-col bg-white animate-fade-in ${!isMobile ? 'left-auto right-0 w-[420px] border-l border-gray-100 shadow-2xl' : ''}`}>
          <header className="h-20 border-b border-gray-100 px-6 flex items-center justify-between bg-white sticky top-0 z-10">
            <div className="flex items-center">
              <button onClick={() => setViewUnassigned(false)} className="w-10 h-10 flex items-center justify-center text-gray-400 mr-2 hover:bg-gray-50 rounded-xl transition-all">
                <i className="fa-solid fa-xmark text-xl"></i>
              </button>
              <h4 className="font-black text-xs text-gray-800 uppercase tracking-widest">Nuevos Tickets</h4>
            </div>
            <span className="bg-red-500 text-white text-[10px] font-black px-3 py-1 rounded-full shadow-lg shadow-red-100">{filteredUnassigned.length}</span>
          </header>
          
          <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50 custom-scrollbar">
            {filteredUnassigned.length === 0 ? (
              <div className="text-center py-20 opacity-20">
                <i className="fa-solid fa-circle-check text-5xl mb-4"></i>
                <p className="font-black text-sm uppercase">No hay tickets pendientes</p>
              </div>
            ) : (
              filteredUnassigned.map(ch => (
                <div key={ch.id} className="p-6 bg-white rounded-[2rem] shadow-sm border border-gray-100 hover:shadow-md transition-all group">
                  <div className="flex justify-between items-center mb-4">
                    <span className="text-[10px] font-black text-red-500 flex items-center px-3 py-1 bg-red-50 rounded-full">
                      <span className="w-2 h-2 bg-red-500 rounded-full mr-2 animate-pulse"></span>
                      {(ch.usuarios && ch.usuarios.includes('npQOEYLQPkNw5GXpvyLl')) ? 'PENDIENTE' : 'NUEVO'}
                    </span>
                    <span className="text-[10px] text-gray-400 font-mono">#{ch.id.slice(-6)}</span>
                  </div>
                  <p className="text-base font-bold text-gray-800 mb-2 capitalize">{getPartnerName(ch)}</p>
                  <div className="flex justify-between items-center mb-6">
                    <p className="text-xs text-gray-500">Motivo: {ch.tipo || 'Consulta General'}</p>
                    <p className="text-[10px] text-gray-400">{formatFriendlyDate(ch.updated)}</p>
                  </div>
                  <button 
                    onClick={async () => {
                      if(selectedAgent) {
                        await assignAgentToChannel(ch.id, selectedAgent.id);
                        setSelectedChannel(ch);
                        setViewUnassigned(false);
                      }
                    }}
                    className="w-full py-4 bg-gray-900 text-white text-[10px] font-black rounded-2xl hover:bg-indigo-600 transition-all uppercase tracking-[0.15em] active:scale-95 shadow-lg shadow-gray-100"
                  >
                    Atender Ticket
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {authPendingAgent && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4 animate-fade-in">
          <div className={`bg-white w-full sm:max-w-sm p-8 flex flex-col items-center shadow-2xl transition-all duration-300 ${isMobile ? 'rounded-t-[3rem] animate-slide-up pb-10' : 'rounded-[3rem]'}`}>
            {isMobile && <div className="w-12 h-1.5 bg-gray-200 rounded-full mb-8 -mt-2"></div>}
            
            <img src={authPendingAgent.image_url} className="w-24 h-24 rounded-[2rem] border-4 border-white shadow-2xl mb-6 object-cover" alt="" />
            <h3 className="text-xl font-black text-gray-800 tracking-tight">{authPendingAgent.nombre}</h3>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-[0.2em] mb-8">Confirmar Agente</p>
            
            <form onSubmit={handleAuth} className="w-full space-y-6">
              <div className="relative">
                <input 
                  autoFocus
                  type="password"
                  value={passwordInput}
                  onChange={(e) => { setPasswordInput(e.target.value); setAuthError(false); }}
                  placeholder="••••"
                  className={`w-full bg-gray-50 border-2 rounded-2xl px-6 py-4 text-center font-black text-2xl tracking-[0.5em] focus:outline-none transition-all ${
                    authError ? 'border-red-200 bg-red-50 text-red-600' : 'border-transparent focus:border-indigo-200 focus:bg-white text-indigo-600'
                  }`}
                />
                {authError && <p className="text-[10px] text-red-500 font-black text-center uppercase mt-4 animate-shake">Error de validación</p>}
              </div>
              <button 
                type="submit" 
                className="w-full bg-indigo-600 text-white font-black py-4 rounded-2xl shadow-xl shadow-indigo-100 hover:scale-[1.02] active:scale-95 transition-all text-[11px] uppercase tracking-[0.2em]"
              >
                Ingresar al Panel
              </button>
              <button 
                type="button" 
                onClick={() => { setAuthPendingAgent(null); setPasswordInput(''); }} 
                className="w-full text-gray-400 text-[10px] font-black uppercase py-2 tracking-widest hover:text-gray-600"
              >
                Volver
              </button>
            </form>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fade-in-left {
          from { opacity: 0; transform: translateX(-15px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes fade-in-down {
          from { opacity: 0; transform: translateY(-15px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slide-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-6px); }
          75% { transform: translateX(6px); }
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .animate-fade-in-left { animation: fade-in-left 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .animate-fade-in-down { animation: fade-in-down 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .animate-fade-in { animation: fade-in 0.3s ease-out forwards; }
        .animate-slide-up { animation: slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .animate-shake { animation: shake 0.2s ease-in-out 0s 2; }
        
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e5e7eb;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #d1d5db;
        }
      `}</style>
    </div>
  );
};

export default App;
