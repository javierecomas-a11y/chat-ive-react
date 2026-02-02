
export interface User {
  id: string;
  image_url: string;
  nombre: string;
  tipo: 'soporte' | 'cliente' | string;
  password?: string;
}

export interface Message {
  id: string;
  origen: string;
  mensaje: string;
  tipo: string;
  resname?: string;
  resurl?: string;
  timestamp: string;
  leido: boolean;
}

export interface Channel {
  id: string;
  tipo: string;
  updated: string;
  usuarios: string[];
}

export interface AppState {
  selectedAgent: User | null;
  selectedChannel: Channel | null;
  unassignedCount: number;
}
