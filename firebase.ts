
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  where, 
  doc, 
  updateDoc, 
  setDoc,
  orderBy, 
  arrayUnion,
  arrayRemove,
  Firestore,
  Timestamp,
  collection,
  onSnapshot,
  getDocs,
  query,
  limit  
} from 'firebase/firestore';
import { 
  getStorage, 
  ref, 
  uploadBytes, 
  getDownloadURL 
} from 'firebase/storage';
import { User } from './types';

const firebaseConfig = {
  projectId: "ejerciciosive",
  apiKey: "YOUR_API_KEY",
  authDomain: "ejerciciosive.firebaseapp.com",
  storageBucket: "ejerciciosive.appspot.com",
  messagingSenderId: "SENDER_ID",
  appId: "APP_ID"
};

const app = initializeApp(firebaseConfig);
export const db: Firestore = getFirestore(app);
export const storage = getStorage(app);

// ID Marcador que indica que el ticket está pendiente de asignación real
const PLACEHOLDER_AGENT_ID = 'npQOEYLQPkNw5GXpvyLl';

export const getSoporteUsers = (callback: (users: User[]) => void) => {
  // Ahora incluimos tanto 'soporte' como 'soporteTecnico'
  const q = query(
    collection(db, 'users'), 
    where('tipo', 'in', ['soporte', 'soporteTecnico'])
  );
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as User)));
  });
};

export const getAllUsers = (callback: (users: Record<string, User>) => void) => {
  return onSnapshot(collection(db, 'users'), (snapshot) => {
    const usersMap: Record<string, User> = {};
    snapshot.docs.forEach(doc => {
      usersMap[doc.id] = { id: doc.id, ...doc.data() } as User;
    });
    callback(usersMap);
  });
};

export const getChannelsByAgent = (agentId: string, callback: (channels: any[]) => void) => {
  const q = query(collection(db, 'channels'), where('usuarios', 'array-contains', agentId));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  });
};

/**
 * Normaliza cualquier formato de tiempo (Timestamp, string, number) a milisegundos.
 */
const normalizeTime = (val: any): number => {
  if (!val) return 0;
  if (val instanceof Timestamp) return val.toMillis();
  if (val && typeof val.toMillis === 'function') return val.toMillis();
  const num = Number(val);
  if (!isNaN(num) && num > 0) return num;
  const date = new Date(val).getTime();
  return isNaN(date) ? 0 : date;
};

export const getUnassignedChannelsTmp = (callback: (channels: any[]) => void) => {
  return onSnapshot(collection(db, 'channels'), (snapshot) => {
    const unassigned = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((c: any) => {
        if (!c.usuarios || !Array.isArray(c.usuarios)) return true;
        if (c.usuarios.includes(PLACEHOLDER_AGENT_ID)) return true;
        return c.usuarios.length < 2;
      })
      .sort((a: any, b: any) => {
        const timeA = normalizeTime(a.updated);
        const timeB = normalizeTime(b.updated);
        return timeB - timeA;
      });
    callback(unassigned);
  });
};

export const getUnassignedChannels = (
  callback: (channels: any[]) => void
) => {
  return onSnapshot(collection(db, 'channels'), async (snapshot) => {

    const candidates = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((c: any) => {
        if (!c.usuarios || !Array.isArray(c.usuarios)) return true;
        if (c.usuarios.includes(PLACEHOLDER_AGENT_ID)) return true;
        return c.usuarios.length < 2;
      });

    // Verificar subcolección messages
    const filteredWithMessages = await Promise.all(
      candidates.map(async (channel: any) => {
        const messagesRef = collection(db, 'channels', channel.id, 'messages');
        const q = query(messagesRef, limit(1));
        const snap = await getDocs(q);

        if (!snap.empty) {
          return channel;
        }
        return null;
      })
    );

    const unassigned = filteredWithMessages
      .filter(Boolean)
      .sort((a: any, b: any) => {
        const timeA = normalizeTime(a.updated);
        const timeB = normalizeTime(b.updated);
        return timeB - timeA;
      });

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
  
  await updateDoc(channelRef, {
    usuarios: arrayRemove(PLACEHOLDER_AGENT_ID)
  });
};

export const uploadAudioFile = async (blob: Blob, fileName: string): Promise<string> => {
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
  tipo: string = '0'
) => {
  const now = Date.now().toString();
  const messageDocRef = doc(db, 'channels', channelId, 'messages', now);
  
  const messageData: any = {
    origen: agentId,
    mensaje: text,
    tipo: tipo,
    timestamp: now,
    leido: false,
    resurl: resurl,
    resname: resname
  };

  await setDoc(messageDocRef, messageData);
  
  const channelRef = doc(db, 'channels', channelId);
  await updateDoc(channelRef, {
    updated: now
  });
};
