import { GoogleGenAI } from "@google/genai";
import "dotenv/config"; // Yeh line ensure karegi ki .env pehle load ho

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("WARNING: GEMINI_API_KEY is not defined in .env file!");
}

const ai = new GoogleGenAI({
    apiKey: apiKey
});

export default ai;