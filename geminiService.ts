
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeConversation = async (messages: string[]) => {
  if (messages.length === 0) return "No hay mensajes para analizar.";
  
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analiza esta conversación de soporte y genera un breve resumen de los puntos clave y el sentimiento del usuario. 
      Conversación:
      ${messages.join('\n')}`,
      config: {
        systemInstruction: "Eres un asistente experto en análisis de soporte técnico. Tu resumen debe ser conciso y útil para un agente de soporte.",
        temperature: 0.7,
      },
    });

    return response.text;
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return "Error al analizar la conversación con AI.";
  }
};

export const suggestReply = async (context: string) => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Basado en el contexto de esta conversación, sugiere una respuesta profesional y empática para el agente de soporte.
      Contexto: ${context}`,
      config: {
        systemInstruction: "Eres un redactor de respuestas de soporte de alta calidad.",
        temperature: 0.8,
      }
    });
    return response.text;
  } catch (error) {
    return null;
  }
};
