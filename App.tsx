
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  getSoporteUsers, 
  getChannelsByAgent, 
  getUnassignedChannels, 
  getMessages, 
  assignAgentToChannel,
  sendMessage,
  uploadAudioFile
} from './firebase';
import { User, Channel, Message } from './types';
import { analyzeConversation, suggestReply } from './geminiService';

// --- Utils ---

const safeNewDate = (dateStr: string | number) => {
  if (!dateStr) return new Date();
  if (typeof dateStr === 'string' && /^\d+$/.test(dateStr)) {
    return new Date(Number(dateStr));
  }
  return new Date(dateStr);
};

const formatTimeOnly = (date: Date) => {
  return date.toLocaleTimeString('es-ES', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit' 
  });
};

const formatFriendlyDate = (dateStr: string) => {
  if (!dateStr) return '';
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
  
  return (
    <div className={`flex flex-col mb-4 ${isMe ? 'items-end' : 'items-start animate-fade-in-left'}`}>
      <div className={`max-w-[85%] sm:max-w-[70%] p-3.5 rounded-2xl shadow-sm relative ${
        isMe 
          ? 'bg-indigo-600 text-white rounded-tr-none' 
          : 'bg-white text-gray-800 rounded-tl-none border border-gray-100'
      }`}>
        {message.tipo === 'audio' || message.resurl ? (
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
  // Navigation & UI States
  const [agents, setAgents] = useState<User[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<User | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [unassignedChannels, setUnassignedChannels] = useState<Channel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [viewUnassigned, setViewUnassigned] = useState(false);
  
  // Platform Detection
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

  // Initial Load
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    const unsubAgents = getSoporteUsers(setAgents);
    const unsubUnassigned = getUnassignedChannels(setUnassignedChannels);
    return () => { 
      window.removeEventListener('resize', handleResize);
      unsubAgents(); 
      unsubUnassigned(); 
    };
  }, []);

  // Real-time Data Sync
  useEffect(() => {
    if (!selectedAgent) return;
    const unsub = getChannelsByAgent(selectedAgent.id, (data) => {
      let active = data.filter(c => c.updated);
      if (selectedAgent.id === 'uJ22Sf8OCPDcEVv5y3n1') {
        active = active.filter(c => c.usuarios.includes('9710'));
      }
      setChannels(active);
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
      const fileName = `${ts}.mp4`;
      const url = await uploadAudioFile(blob, fileName);
      await sendMessage(selectedChannel.id, selectedAgent.id, '', url, fileName, 'audio');
    } catch (error) {
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

  // Mobile Views Logic
  const showChatMobile = isMobile && selectedChannel && !viewUnassigned;
  const showChannelsMobile = isMobile && selectedAgent && !selectedChannel && !viewUnassigned;
  const showAgentsMobile = isMobile && !selectedAgent && !viewUnassigned;

  return (
    <div className="flex h-[100svh] w-full bg-gray-50 font-sans overflow-hidden select-none">
      
      {/* Column 1: Agentes (Desktop) / Mobile: Initial Screen */}
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
                
                {!isMobile && (
                  <div className="hidden lg:block">
                     <div className="bg-gray-50 p-4 rounded-2xl border border-gray-100">
                        <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest mb-2">Resumen de Hoy</p>
                        <div className="flex justify-between items-center text-xs font-bold text-gray-700">
                           <span>Tickets atendidos</span>
                           <span className="text-indigo-600">12</span>
                        </div>
                     </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      )}

      {/* Column 2: Canales (Desktop) / Mobile: Middle Screen */}
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
              {unassignedChannels.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[9px] w-4 h-4 rounded-full flex items-center justify-center border-2 border-white animate-bounce">
                  {unassignedChannels.length}
                </span>
              )}
            </button>
          </header>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
            {channels.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center opacity-20 p-8">
                <i className="fa-solid fa-inbox text-5xl mb-4"></i>
                <p className="font-black uppercase tracking-tighter">Sin chats asignados</p>
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
                  <p className="text-sm font-bold text-gray-800 capitalize">{ch.tipo}</p>
                  <p className="text-[10px] text-gray-400 mt-1 truncate">Última actividad hace unos momentos</p>
                </button>
              ))
            )}
          </div>
        </section>
      )}

      {/* Column 3: Chat Main (Desktop) / Mobile: Chat View */}
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
                  <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center mr-3 flex-shrink-0 shadow-inner">
                    <i className="fa-solid fa-hashtag"></i>
                  </div>
                  <div className="overflow-hidden">
                    <h2 className="font-black text-gray-800 tracking-tight text-sm sm:text-base truncate">Canal {selectedChannel.tipo}</h2>
                    <p className="text-[10px] text-green-500 font-black uppercase tracking-widest flex items-center">
                      <span className="w-1.5 h-1.5 bg-green-500 rounded-full mr-2 animate-pulse"></span> #{selectedChannel.id.slice(-6)}
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
                    <p className="font-black uppercase tracking-widest text-xs">Esperando el primer mensaje...</p>
                  </div>
                ) : (
                  messages.map(m => (
                    <ChatBubble key={m.id} message={m} isMe={m.origen === selectedAgent?.id} />
                  ))
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="p-4 sm:p-6 bg-white border-t border-gray-100">
                <div className="max-w-4xl mx-auto">
                  {isRecording ? (
                    <div className="flex items-center justify-between bg-red-50 p-4 rounded-3xl border-2 border-red-100 animate-pulse">
                      <div className="flex items-center text-red-600 font-black text-xs uppercase tracking-widest">
                        <span className="w-2.5 h-2.5 bg-red-600 rounded-full mr-3 animate-ping"></span>
                        Gravando: {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                      </div>
                      <button onClick={stopRecording} className="px-6 py-2 bg-red-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest active:scale-95 transition-all">
                        Enviar Audio
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleSendMessage} className="relative group">
                      <textarea 
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Respuesta del agente..."
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
                          disabled={!newMessage.trim() || isUploading}
                          className="w-10 h-10 bg-indigo-600 text-white rounded-xl flex items-center justify-center shadow-lg shadow-indigo-100 hover:scale-105 active:scale-95 transition-all disabled:opacity-30"
                        >
                          <i className={`fa-solid ${isUploading ? 'fa-spinner fa-spin' : 'fa-paper-plane'} text-xs`}></i>
                        </button>
                      </div>
                    </form>
                  )}
                  
                  <div className="flex items-center justify-between mt-4 px-2">
                    <p className="hidden lg:block text-[9px] text-gray-300 font-bold uppercase tracking-[0.2em]">Operador ID: {selectedAgent?.id.slice(0,8)}</p>
                    <div className="flex items-center justify-between w-full lg:w-auto lg:space-x-8">
                      <button 
                        onClick={isRecording ? stopRecording : startRecording} 
                        className={`p-3 transition-all active:scale-90 ${isRecording ? 'text-red-500 scale-125' : 'text-gray-400 hover:text-indigo-600'}`}
                      >
                        <i className="fa-solid fa-microphone text-xl"></i>
                      </button>
                      <div className="flex space-x-6">
                        <button className="p-3 text-gray-400 hover:text-indigo-600 active:scale-90"><i className="fa-solid fa-image text-xl"></i></button>
                        <button className="p-3 text-gray-400 hover:text-indigo-600 active:scale-90"><i className="fa-solid fa-paperclip text-xl"></i></button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-12 bg-[#FAFAFA]">
              <div className="w-28 h-28 bg-white rounded-[2.5rem] shadow-2xl shadow-gray-200/50 flex items-center justify-center mb-10 rotate-3 hover:rotate-0 transition-all duration-500 group">
                <i className="fa-solid fa-headset text-5xl text-indigo-600 group-hover:scale-110 transition-transform"></i>
              </div>
              <h3 className="text-2xl font-black text-gray-800 uppercase tracking-tighter">Centro de Ayuda</h3>
              <p className="max-w-xs text-sm mt-4 text-gray-400 font-medium leading-relaxed">Selecciona un canal de la lista para comenzar a interactuar con el cliente.</p>
            </div>
          )}
        </main>
      )}

      {/* Overlays & Modals */}

      {/* Tickets No Asignados Overlay */}
      {viewUnassigned && (
        <div className={`fixed inset-0 z-40 flex flex-col bg-white animate-fade-in ${!isMobile ? 'left-auto right-0 w-[420px] border-l border-gray-100 shadow-2xl' : ''}`}>
          <header className="h-20 border-b border-gray-100 px-6 flex items-center justify-between bg-white sticky top-0 z-10">
            <div className="flex items-center">
              <button onClick={() => setViewUnassigned(false)} className="w-10 h-10 flex items-center justify-center text-gray-400 mr-2 hover:bg-gray-50 rounded-xl transition-all">
                <i className="fa-solid fa-xmark text-xl"></i>
              </button>
              <h4 className="font-black text-xs text-gray-800 uppercase tracking-widest">Bandeja de Entrada</h4>
            </div>
            <span className="bg-red-500 text-white text-[10px] font-black px-3 py-1 rounded-full shadow-lg shadow-red-100">{unassignedChannels.length}</span>
          </header>
          
          <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-gray-50 custom-scrollbar">
            {unassignedChannels.length === 0 ? (
              <div className="text-center py-20 opacity-20">
                <i className="fa-solid fa-circle-check text-5xl mb-4"></i>
                <p className="font-black text-sm uppercase">Sin tickets pendientes</p>
              </div>
            ) : (
              unassignedChannels.map(ch => (
                <div key={ch.id} className="p-6 bg-white rounded-[2rem] shadow-sm border border-gray-100 hover:shadow-md transition-all group">
                  <div className="flex justify-between items-center mb-4">
                    <span className="text-[10px] font-black text-red-500 flex items-center px-3 py-1 bg-red-50 rounded-full">
                      <span className="w-2 h-2 bg-red-500 rounded-full mr-2 animate-pulse"></span>
                      ALTA PRIORIDAD
                    </span>
                    <span className="text-[10px] text-gray-400 font-mono">#{ch.id.slice(-6)}</span>
                  </div>
                  <p className="text-base font-bold text-gray-800 mb-6 capitalize">Solicitud de {ch.tipo}</p>
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
                    Tomar Ticket Ahora
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Authentication Modal / Bottom-Sheet */}
      {authPendingAgent && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4 animate-fade-in">
          <div className={`bg-white w-full sm:max-w-sm p-8 flex flex-col items-center shadow-2xl transition-all duration-300 ${isMobile ? 'rounded-t-[3rem] animate-slide-up pb-10' : 'rounded-[3rem]'}`}>
            {isMobile && <div className="w-12 h-1.5 bg-gray-200 rounded-full mb-8 -mt-2"></div>}
            
            <img src={authPendingAgent.image_url} className="w-24 h-24 rounded-[2rem] border-4 border-white shadow-2xl mb-6 object-cover" alt="" />
            <h3 className="text-xl font-black text-gray-800 tracking-tight">{authPendingAgent.nombre}</h3>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-[0.2em] mb-8">Confirmación de Identidad</p>
            
            <form onSubmit={handleAuth} className="w-full space-y-6">
              <div className="relative">
                <input 
                  autoFocus
                  type="password"
                  value={passwordInput}
                  onChange={(e) => { setPasswordInput(e.target.value); setAuthError(false); }}
                  placeholder="••••••"
                  className={`w-full bg-gray-50 border-2 rounded-2xl px-6 py-4 text-center font-black text-2xl tracking-[0.5em] focus:outline-none transition-all ${
                    authError ? 'border-red-200 bg-red-50 text-red-600' : 'border-transparent focus:border-indigo-200 focus:bg-white text-indigo-600'
                  }`}
                />
                {authError && <p className="text-[10px] text-red-500 font-black text-center uppercase mt-4 animate-shake">Contraseña Incorrecta</p>}
              </div>
              <button 
                type="submit" 
                className="w-full bg-indigo-600 text-white font-black py-4 rounded-2xl shadow-xl shadow-indigo-100 hover:scale-[1.02] active:scale-95 transition-all text-[11px] uppercase tracking-[0.2em]"
              >
                Acceder al Panel
              </button>
              <button 
                type="button" 
                onClick={() => { setAuthPendingAgent(null); setPasswordInput(''); }} 
                className="w-full text-gray-400 text-[10px] font-black uppercase py-2 tracking-widest hover:text-gray-600"
              >
                Cancelar
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
