
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

// --- Formateo de Fechas ---

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

// --- Componentes ---

const ChatBubble: React.FC<{ message: Message; isMe: boolean }> = ({ message, isMe }) => {
  const date = safeNewDate(message.timestamp);
  
  return (
    <div className={`flex flex-col mb-4 ${isMe ? 'items-end' : 'items-start animate-fade-in-left'}`}>
      <div className={`max-w-[80%] p-3.5 rounded-2xl shadow-sm relative ${
        isMe 
          ? 'bg-indigo-600 text-white rounded-tr-none' 
          : 'bg-white text-gray-800 rounded-tl-none border border-gray-100'
      }`}>
        {message.tipo === 'audio' || message.resurl ? (
          <div className="flex flex-col space-y-2 min-w-[240px]">
            {message.mensaje && <p className="text-sm mb-1">{message.mensaje}</p>}
            <div className={`flex items-center rounded-xl p-2 ${isMe ? 'bg-indigo-500' : 'bg-gray-50'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center mr-3 ${isMe ? 'bg-indigo-400' : 'bg-indigo-100 text-indigo-600'}`}>
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
  const [agents, setAgents] = useState<User[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<User | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [unassignedChannels, setUnassignedChannels] = useState<Channel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [viewUnassigned, setViewUnassigned] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Auth
  const [authPendingAgent, setAuthPendingAgent] = useState<User | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState(false);

  // Audio
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubAgents = getSoporteUsers(setAgents);
    const unsubUnassigned = getUnassignedChannels(setUnassignedChannels);
    return () => { unsubAgents(); unsubUnassigned(); };
  }, []);

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

  return (
    <div className="flex h-screen w-full bg-[#F3F4F6] font-sans">
      {/* Sidebar de Agentes */}
      <aside className="w-80 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-100">
          <h1 className="text-xl font-black text-indigo-600 flex items-center">
            <i className="fa-solid fa-comments-medical mr-2"></i> IVE SUPPORT
          </h1>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4">
          {!selectedAgent ? (
            <div className="space-y-3">
              <h2 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">Seleccionar Operador</h2>
              {agents.map(agent => (
                <button
                  key={agent.id}
                  onClick={() => setAuthPendingAgent(agent)}
                  className="w-full flex items-center p-3 rounded-2xl hover:bg-indigo-50 border border-transparent hover:border-indigo-100 transition-all group"
                >
                  <img src={agent.image_url} className="w-12 h-12 rounded-full object-cover mr-3 shadow-sm border-2 border-transparent group-hover:border-indigo-200" alt={agent.nombre} />
                  <div className="text-left">
                    <p className="font-bold text-gray-800">{agent.nombre}</p>
                    <p className="text-[10px] text-gray-400 uppercase font-black">{agent.tipo}</p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="p-4 bg-indigo-600 rounded-2xl text-white shadow-lg shadow-indigo-100">
                <div className="flex items-center mb-4">
                  <img src={selectedAgent.image_url} className="w-12 h-12 rounded-full border-2 border-white/20 mr-3" alt={selectedAgent.nombre} />
                  <div>
                    <p className="font-black text-sm">{selectedAgent.nombre}</p>
                    <p className="text-[10px] text-white/70 uppercase">Online</p>
                  </div>
                </div>
                <button onClick={() => setSelectedAgent(null)} className="w-full py-2 bg-white/10 hover:bg-white/20 rounded-xl text-xs font-bold transition-all">
                  Cerrar Sesión
                </button>
              </div>

              <div>
                <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 flex justify-between">
                  Tus Chats <span>{channels.length}</span>
                </h3>
                <div className="space-y-1">
                  {channels.map(ch => (
                    <button
                      key={ch.id}
                      onClick={() => setSelectedChannel(ch)}
                      className={`w-full text-left p-4 rounded-2xl transition-all ${
                        selectedChannel?.id === ch.id ? 'bg-indigo-50 border-indigo-200 border shadow-sm' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-[10px] font-black text-indigo-500">#{ch.id.slice(-5)}</span>
                        <span className="text-[9px] text-gray-400">{formatFriendlyDate(ch.updated)}</span>
                      </div>
                      <p className="text-xs font-bold text-gray-700 capitalize">{ch.tipo}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Panel Central */}
      <section className="flex-1 flex flex-col bg-white">
        {selectedChannel ? (
          <>
            <header className="h-20 border-b border-gray-100 px-8 flex items-center justify-between">
              <div className="flex items-center">
                <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center mr-4">
                  <i className="fa-solid fa-headset"></i>
                </div>
                <div>
                  <h2 className="font-black text-gray-800 tracking-tight">Ticket #{selectedChannel.id.slice(-6)}</h2>
                  <p className="text-[10px] text-green-500 font-bold uppercase tracking-widest flex items-center">
                    <span className="w-1.5 h-1.5 bg-green-500 rounded-full mr-2 animate-pulse"></span> Activo
                  </p>
                </div>
              </div>
              
              <div className="flex items-center space-x-3">
                <button 
                  onClick={async () => {
                    setIsAnalyzing(true);
                    const res = await analyzeConversation(messages.map(m => `${m.origen}: ${m.mensaje}`));
                    setAiSummary(res);
                    setIsAnalyzing(false);
                  }}
                  disabled={isAnalyzing || messages.length === 0}
                  className="px-4 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-black uppercase hover:bg-indigo-100 transition-all disabled:opacity-50"
                >
                  <i className={`fa-solid ${isAnalyzing ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'} mr-2`}></i>
                  Gemini Análisis
                </button>
                <button 
                  onClick={() => setViewUnassigned(!viewUnassigned)}
                  className={`p-3 rounded-xl transition-all relative ${viewUnassigned ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-400 hover:text-gray-600'}`}
                >
                  <i className="fa-solid fa-inbox"></i>
                  {unassignedChannels.length > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[9px] w-4 h-4 rounded-full flex items-center justify-center border-2 border-white animate-bounce">
                      {unassignedChannels.length}
                    </span>
                  )}
                </button>
              </div>
            </header>

            {aiSummary && (
              <div className="m-6 p-4 bg-indigo-50 rounded-2xl border border-indigo-100 relative animate-fade-in-down">
                <button onClick={() => setAiSummary(null)} className="absolute top-3 right-3 text-indigo-300 hover:text-indigo-600">
                  <i className="fa-solid fa-circle-xmark"></i>
                </button>
                <div className="flex">
                  <i className="fa-solid fa-robot text-indigo-500 mt-1 mr-3"></i>
                  <p className="text-xs text-indigo-900 leading-relaxed font-medium">{aiSummary}</p>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-8 bg-[#F9FAFB] scroll-smooth">
              {messages.map((m, i) => (
                <ChatBubble key={m.id} message={m} isMe={m.origen === selectedAgent?.id} />
              ))}
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center opacity-30">
                  <i className="fa-solid fa-message-dots text-6xl mb-4"></i>
                  <p className="font-black uppercase tracking-widest text-sm">Esperando mensajes...</p>
                </div>
              )}
            </div>

            <div className="p-6 bg-white border-t border-gray-100">
              <div className="max-w-4xl mx-auto">
                {isRecording ? (
                  <div className="flex items-center justify-between bg-red-50 p-4 rounded-2xl border-2 border-red-100 animate-pulse">
                    <div className="flex items-center text-red-600 font-bold">
                      <span className="w-2 h-2 bg-red-600 rounded-full mr-3 animate-ping"></span>
                      Grabando... {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                    </div>
                    <button onClick={stopRecording} className="px-6 py-2 bg-red-600 text-white rounded-xl text-xs font-black uppercase">
                      Detener y Enviar
                    </button>
                  </div>
                ) : (
                  <form onSubmit={(e) => { e.preventDefault(); if(newMessage.trim()) { sendMessage(selectedChannel.id, selectedAgent!.id, newMessage); setNewMessage(''); } }} className="relative">
                    <textarea 
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      placeholder="Escribe tu mensaje..."
                      className="w-full bg-gray-50 border-2 border-transparent focus:border-indigo-100 focus:bg-white rounded-2xl px-6 py-4 pr-32 text-sm focus:outline-none transition-all resize-none min-h-[56px] shadow-inner"
                      onKeyDown={(e) => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                    />
                    <div className="absolute right-4 bottom-3 flex space-x-2">
                      <button 
                        type="button" 
                        onClick={async () => {
                          const suggestion = await suggestReply(messages.slice(-3).map(m => m.mensaje).join('|'));
                          if(suggestion) setNewMessage(suggestion);
                        }}
                        className="w-10 h-10 flex items-center justify-center text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl"
                      >
                        <i className="fa-solid fa-sparkles"></i>
                      </button>
                      <button 
                        type="submit"
                        disabled={!newMessage.trim()}
                        className="w-10 h-10 bg-indigo-600 text-white rounded-xl flex items-center justify-center shadow-lg shadow-indigo-100 hover:scale-105 transition-all disabled:opacity-30"
                      >
                        <i className="fa-solid fa-paper-plane text-xs"></i>
                      </button>
                    </div>
                  </form>
                )}
                
                <div className="flex items-center justify-between mt-4 px-2">
                  <p className="text-[9px] text-gray-400 font-bold uppercase tracking-[0.2em]">Agente: {selectedAgent?.nombre}</p>
                  <div className="flex space-x-6">
                    <button 
                      onClick={isRecording ? stopRecording : startRecording} 
                      className={`transition-all ${isRecording ? 'text-red-500 scale-125' : 'text-gray-400 hover:text-indigo-600'}`}
                    >
                      <i className="fa-solid fa-microphone text-lg"></i>
                    </button>
                    <button className="text-gray-400 hover:text-indigo-600"><i className="fa-solid fa-image text-lg"></i></button>
                    <button className="text-gray-400 hover:text-indigo-600"><i className="fa-solid fa-paperclip text-lg"></i></button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-12 opacity-40">
            <div className="w-24 h-24 bg-gray-100 rounded-3xl flex items-center justify-center mb-6">
              <i className="fa-solid fa-comments text-4xl text-gray-300"></i>
            </div>
            <h3 className="text-xl font-black text-gray-800 uppercase tracking-tighter">Bienvenido al Panel de Soporte</h3>
            <p className="max-w-xs text-sm mt-2">Selecciona un chat activo en el lateral para comenzar la asistencia técnica.</p>
          </div>
        )}
      </section>

      {/* Modal de Validación de Agente */}
      {authPendingAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-8 flex flex-col items-center">
            <img src={authPendingAgent.image_url} className="w-24 h-24 rounded-full border-4 border-indigo-50 shadow-xl mb-4 object-cover" alt="" />
            <h3 className="text-xl font-black text-gray-800">{authPendingAgent.nombre}</h3>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-6">Ingresa tu clave de acceso</p>
            
            <form onSubmit={handleAuth} className="w-full space-y-4">
              <input 
                autoFocus
                type="password"
                value={passwordInput}
                onChange={(e) => { setPasswordInput(e.target.value); setAuthError(false); }}
                placeholder="Contraseña"
                className={`w-full bg-gray-50 border-2 rounded-2xl px-6 py-4 text-center font-black tracking-widest focus:outline-none transition-all ${
                  authError ? 'border-red-200 bg-red-50' : 'border-transparent focus:border-indigo-100'
                }`}
              />
              {authError && <p className="text-[10px] text-red-500 font-bold text-center uppercase animate-shake">Contraseña Incorrecta</p>}
              <button type="submit" className="w-full bg-indigo-600 text-white font-black py-4 rounded-2xl shadow-lg shadow-indigo-100 hover:scale-[1.02] active:scale-95 transition-all text-xs uppercase tracking-widest">
                Confirmar Identidad
              </button>
              <button type="button" onClick={() => {setAuthPendingAgent(null); setPasswordInput('');}} className="w-full text-gray-400 text-[10px] font-bold uppercase py-2">Cancelar</button>
            </form>
          </div>
        </div>
      )}

      {/* Lista Global de no asignados (Overlay) */}
      {viewUnassigned && (
        <div className="fixed top-20 right-8 w-80 bg-white shadow-2xl rounded-3xl border border-gray-100 p-6 z-40 animate-fade-in-down max-h-[70vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <h4 className="font-black text-xs text-gray-800 uppercase tracking-tighter">Bandeja de Entrada</h4>
            <span className="bg-red-100 text-red-600 text-[10px] font-black px-2 py-0.5 rounded-full">{unassignedChannels.length}</span>
          </div>
          <div className="space-y-3">
            {unassignedChannels.map(ch => (
              <div key={ch.id} className="p-4 bg-gray-50 rounded-2xl border border-gray-100 group">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] font-black text-red-500">NUEVO TICKET</span>
                  <span className="text-[10px] text-gray-400">#{ch.id.slice(-5)}</span>
                </div>
                <p className="text-xs font-bold text-gray-700 mb-3 capitalize">Tipo: {ch.tipo}</p>
                <button 
                  onClick={async () => {
                    if(selectedAgent) {
                      await assignAgentToChannel(ch.id, selectedAgent.id);
                      setViewUnassigned(false);
                    }
                  }}
                  className="w-full py-2.5 bg-gray-900 text-white text-[10px] font-black rounded-xl hover:bg-indigo-600 transition-all uppercase"
                >
                  Asignarme ahora
                </button>
              </div>
            ))}
            {unassignedChannels.length === 0 && <p className="text-center text-[10px] text-gray-400 py-6">No hay tickets pendientes</p>}
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
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-4px); }
          75% { transform: translateX(4px); }
        }
        .animate-fade-in-left { animation: fade-in-left 0.3s ease-out forwards; }
        .animate-fade-in-down { animation: fade-in-down 0.3s ease-out forwards; }
        .animate-fade-in { animation: fade-in 0.3s ease-out forwards; }
        .animate-shake { animation: shake 0.2s ease-in-out 0s 2; }
      `}</style>
    </div>
  );
};

export default App;
