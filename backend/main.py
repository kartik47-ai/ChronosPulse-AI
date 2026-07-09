import os
import httpx
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

# Load environment variables from a .env file
load_dotenv()

app = FastAPI(
    title="AI Healthcare Triage API",
    description="A lightweight API for symptom classification and triage scoring.",
    version="1.0.0"
) 

# 1. CORS Configuration
origins = [
    "https://chronos-pulse-oeb47n69i-kk1dgca-5078s-projects.vercel.app", # The exact URL from your screenshot
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "*" # Keep this for now to ensure it works
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,  
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 🔐 2. Configuration: Environment Variables
HF_TOKEN = os.getenv("HF_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

HF_MODEL_URL = "https://api-inference.huggingface.co/models/NeuMed/BioBERT-clinical-triage"

class SymptomRequest(BaseModel):
    symptom_text: str

def calculate_wait_time(urgency_label: str) -> int:
    mapping = {
        "Emergency": 5,      
        "Urgent": 25,        
        "Routine": 60        
    }
    return mapping.get(urgency_label, 45)

@app.get("/")
def read_root():
    return {"status": "online", "message": "Healthcare Triage API is running free and optimized."}

@app.post("/api/triage", status_code=status.HTTP_200_OK)
async def classify_symptoms(payload: SymptomRequest):
    if not payload.symptom_text.strip():
        raise HTTPException(status_code=400, detail="Symptom text cannot be empty.")
    
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise HTTPException(
            status_code=500,
            detail="Supabase credentials missing from backend environment variables."
        )

    # Default values agar AI model fail ho jaye
    urgency = "Urgent"
    confidence = 0.8500
    
    # Text rules for basic fallback matching
    text_lower = payload.symptom_text.lower()
    if "chest pain" in text_lower or "severe" in text_lower or "heart" in text_lower:
        urgency = "Emergency"
    elif "fever" in text_lower or "vomit" in text_lower:
        urgency = "Urgent"
    elif "cough" in text_lower or "cold" in text_lower:
        urgency = "Routine"

    # AI Model call with robust Fallback
    if HF_TOKEN:
        headers = {"Authorization": f"Bearer {HF_TOKEN}"}
        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    HF_MODEL_URL,
                    headers=headers,
                    json={"inputs": payload.symptom_text},
                    timeout=15.0
                )
                
                # Agar Hugging face active hai aur 200 de raha hai tabhi override karein
                if response.status_code == 200:
                    prediction_results = response.json()
                    print("HUGGING FACE RESPONSE IS:", prediction_results)
                    
                    if isinstance(prediction_results, list) and len(prediction_results) > 0:
                        top_prediction = prediction_results[0]
                        if isinstance(top_prediction, list):  
                            top_prediction = top_prediction[0]
                        
                        urgency = top_prediction.get("label", urgency)
                        confidence = top_prediction.get("score", confidence)
                else:
                    print(f"⚠️ Hugging Face returned status {response.status_code}. Using fallback rule-based system.")
            except Exception as e:
                print(f"⚠️ Hugging Face API timed out or threw error: {str(e)}. Using fallback system.")
    else:
        print("⚠️ HF_TOKEN missing. Using rule-based fallback system.")

    estimated_wait = calculate_wait_time(urgency)
    
    # 🗄️ Push directly into Supabase (This will always run now!)
    async with httpx.AsyncClient() as client:
        supabase_headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }
        
        db_payload = {
            "symptom_text": payload.symptom_text,
            "urgency_level": urgency,
            "confidence_score": round(confidence, 4),
            "estimated_wait_minutes": estimated_wait,
            "queue_status": "Waiting"
        }
        
        db_url = f"{SUPABASE_URL}/rest/v1/triage_queue"
        
        try:
            db_response = await client.post(
                db_url,
                headers=supabase_headers,
                json=db_payload,
                timeout=10.0
            )
            
            if db_response.status_code not in [200, 201]:
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to write to Supabase database: {db_response.text}"
                )
            
            return db_response.json()[0]
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=503, 
                detail=f"Failed to communicate with Supabase: {str(exc)}"
            )
