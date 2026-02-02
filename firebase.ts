
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  collection, 
  query, 
  where, 
  onSnapshot, 
  doc, 
  updateDoc, 
  addDoc, 
  orderBy, 
  limit,
  arrayUnion,
  Firestore
} from 'firebase/firestore';
import { 
  getStorage, 
  ref, 
  uploadBytes, 
  getDownloadURL 
} from 'firebase/storage';

const firebaseConfig = {
  projectId: "ejerciciosive",
  apiKey: "YOUR_API_KEY", // La clave se inyecta por el entorno si está disponible
  authDomain: "ejerciciosive.firebaseapp.com",
  storageBucket: "ejerciciosive.appspot.com",
  messagingSenderId: "SENDER_ID",
  appId: "APP_ID"
};

const app = initializeApp(firebaseConfig);
export const db: Firestore = getFirestore(app);
export const storage = getStorage(app);

export const getSoporteUsers = (callback: (users: any[]) => void) => {
  const q = query(collection(db, 'users'), where('tipo', '==', 'soporte'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  });
};

export const getChannelsByAgent = (agentId: string, callback: (channels: any[]) => void) => {
  const q = query(collection(db, 'channels'), where('usuarios', 'array-contains', agentId));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  });
};

export const getUnassignedChannels = (callback: (channels: any[]) => void) => {
  const q = query(collection(db, 'channels'));
  return onSnapshot(q, (snapshot) => {
    // Un canal se considera no asignado si solo tiene 1 usuario (el cliente)
    const unassigned = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((c: any) => c.usuarios && c.usuarios.length === 1);
    callback(unassigned);
  });
};

export const getMessages = (channelId: string, callback: (messages: any[]) => void) => {
  const q = query(
    collection(db, 'channels', channelId, 'messages'),
    orderBy('timestamp', 'asc')
  );
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  });
};

export const assignAgentToChannel = async (channelId: string, agentId: string) => {
  const channelRef = doc(db, 'channels', channelId);
  const now = Date.now().toString();
  await updateDoc(channelRef, {
    usuarios: arrayUnion(agentId),
    updated: now
  });
};

export const uploadAudioFile = async (blob: Blob, fileName: string): Promise<string> => {
  // Aseguramos que el MIME type sea correcto para Firebase Storage
  const storageRef = ref(storage, fileName);
  const metadata = { contentType: 'audio/mp4' };
  const snapshot = await uploadBytes(storageRef, blob, metadata);
  return await getDownloadURL(snapshot.ref);
};

export const sendMessage = async (
  channelId: string, 
  agentId: string, 
  text: string, 
  resurl: string = '', 
  resname: string = '',
  tipo: string = 'text'
) => {
  const now = Date.now().toString();
  const messagesRef = collection(db, 'channels', channelId, 'messages');
  
  const messageData: any = {
    origen: agentId,
    mensaje: text,
    tipo: tipo,
    timestamp: now,
    leido: false
  };

  if (resurl) {
    messageData.resurl = resurl;
    messageData.resname = resname;
  }

  await addDoc(messagesRef, messageData);
  
  const channelRef = doc(db, 'channels', channelId);
  await updateDoc(channelRef, {
    updated: now
  });
};
