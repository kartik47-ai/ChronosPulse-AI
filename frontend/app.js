// Replace these with your actual Supabase credentials
const SUPABASE_URL = "https://hdbwapndudnbcexxzoxk.supabase.co";
const SUPABASE_KEY = "sb_publishable_EiwxmwNC1cwbkyNoDp3PHA_86EyxwoN";

// IMPORTANT: Point this to your actual public backend Codespace URL!
const BACKEND_API_URL = "https://curly-garbanzo-x5jxr5g6p94wcp9gq-8000.app.github.dev/api/triage";

// Initialize Supabase Client using the window context to avoid global naming collisions
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
let staffMode = false;

document.addEventListener("DOMContentLoaded", () => {
    fetchInitialQueue();
    setupRealtimeSubscription();

    // Submit button click event listener
    const submitBtn = document.getElementById("submitBtn");
    if (submitBtn) {
        submitBtn.addEventListener("click", submitSymptom);
    }
});

// Fetch current rows on page load
async function fetchInitialQueue() {
    const { data, error } = await supabaseClient
        .from('triage_queue')
        .select('*')
        .not('queue_status', 'eq', 'Completed') // Don't load already completed items
        .order('id', { ascending: false });
    
    if (error) {
        console.error("Error fetching queue:", error);
    } else {
        const tbody = document.getElementById("queueTableBody");
        if (tbody) {
            tbody.innerHTML = ""; // Clear existing rows
            data.forEach(item => appendQueueRow(item, false));
        }
        updateAnalyticsCounters(); // Run counts on initial load
    }
}

// 🔴 LISTEN TO DATABASE CHANGES IN REAL TIME
function setupRealtimeSubscription() {
    supabaseClient
        .channel('schema-db-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'triage_queue' }, payload => {
            console.log("Realtime event received:", payload);
            
            if (payload.eventType === 'INSERT') {
                appendQueueRow(payload.new, true);
            } else if (payload.eventType === 'UPDATE') {
                handleLiveUpdate(payload.new);
            } else if (payload.eventType === 'DELETE') {
                const row = document.getElementById(`row-${payload.old.id}`);
                if (row) row.remove();
            }
            
            // Recalculate dashboard counters on every DB change
            updateAnalyticsCounters();
        })
        .subscribe();
}

// Render row into UI
function appendQueueRow(item, isNew = false) {
    const tbody = document.getElementById("queueTableBody");
    if (!tbody) return;
    
    // Check if row already exists to avoid duplication
    if (document.getElementById(`row-${item.id}`)) return;

    // 🎨 Dynamically map styles based on urgency level
    let badgeStyle = "background-color: #6c757d; color: white; font-weight: bold; padding: 5px 10px; border-radius: 4px;"; // Default gray
    const urgency = String(item.urgency_level).toLowerCase();
    
    if (urgency === "emergency" || urgency === "critical") {
        badgeStyle = "background-color: #dc3545; color: white; font-weight: bold; padding: 5px 10px; border-radius: 4px;"; // Red 🔴
    } else if (urgency === "urgent") {
        badgeStyle = "background-color: #fd7e14; color: white; font-weight: bold; padding: 5px 10px; border-radius: 4px;"; // Orange 🟠
    } else if (urgency === "routine" || urgency === "non-urgent") {
        badgeStyle = "background-color: #28a745; color: white; font-weight: bold; padding: 5px 10px; border-radius: 4px;"; // Green 🟢
    }

    const row = document.createElement("tr");
    row.id = `row-${item.id}`;
    row.style.transition = "all 0.5s ease"; // Smooth look for real-time additions
    
    row.innerHTML = `
        <td>#${item.id}</td>
        <td>${item.symptom_text}</td>
        <td><span style="${badgeStyle}">${item.urgency_level}</span></td>
        <td>⏱️ ${item.estimated_wait_minutes} mins</td>
        <td id="status-${item.id}"><strong>${item.queue_status}</strong></td>
        <td class="staff-col" style="display: ${staffMode ? 'table-cell' : 'none'};">
            <button onclick="updateStatus(${item.id}, 'Serving')" style="background-color: #ffc107; color: black; border: none; padding: 6px 10px; font-size: 12px; margin-right: 5px; cursor: pointer; border-radius: 3px;">Serve</button>
            <button onclick="updateStatus(${item.id}, 'Completed')" style="background-color: #28a745; color: white; border: none; padding: 6px 10px; font-size: 12px; cursor: pointer; border-radius: 3px;">Done</button>
        </td>
    `;

    if (isNew) {
        tbody.insertBefore(row, tbody.firstChild); // Put new additions at top
    } else {
        tbody.appendChild(row);
    }
}

// Post symptom data to your local FastAPI backend
async function submitSymptom() {
    const input = document.getElementById("symptomInput");
    if (!input) return;
    
    const symptomText = input.value.trim();
    if (!symptomText) return alert("Please type your symptoms first!");

    try {
        const response = await fetch(BACKEND_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symptom_text: symptomText })
        });
        
        if (response.ok) {
            input.value = ""; // Clear input on success
        } else {
            alert("Backend processing failed. Check your FastAPI console logs.");
        }
    } catch (err) {
        console.error("Network error connecting to Backend:", err);
    }
} 

// Triggered when a staff member updates a patient's status
function handleLiveUpdate(item) {
    const row = document.getElementById(`row-${item.id}`);
    if (!row) return;

    if (item.queue_status === 'Completed') {
        row.remove(); // Drop from view completely if finished
    } else {
        const statusCell = document.getElementById(`status-${item.id}`);
        if (statusCell) statusCell.innerHTML = `<strong>${item.queue_status}</strong>`;
    }
}

// Push status change straight to Supabase
async function updateStatus(id, newStatus) {
    const { error } = await supabaseClient
        .from('triage_queue')
        .update({ queue_status: newStatus })
        .eq('id', id);
        
    if (error) alert("Update failed: " + error.message);
}

// Show/Hide buttons when staff toggle is clicked
function toggleStaffMode() {
    staffMode = !staffMode;
    document.querySelectorAll('.staff-col').forEach(col => {
        col.style.display = staffMode ? 'table-cell' : 'none';
    });
}

// 📊 Live Analytics Counters logic
function updateAnalyticsCounters() {
    const rows = document.querySelectorAll("#queueTableBody tr");
    let totalWaiting = 0;
    let highPriorityCount = 0;

    rows.forEach(row => {
        const statusCell = row.querySelector("td:nth-child(5)");
        const urgencyCell = row.querySelector("td:nth-child(3)");
        
        if (statusCell && urgencyCell) {
            const statusText = statusCell.innerText.trim();
            const urgencyText = urgencyCell.innerText.trim().toLowerCase();

            if (statusText !== "Completed") {
                totalWaiting++;
                if (urgencyText === "emergency" || urgencyText === "critical") {
                    highPriorityCount++;
                }
            }
        }
    });

    // Aapki screen par counters ki ID 'totalWaitingCount' aur 'emergencyCount' ho toh ye unhe badal dega
    const totalCountEl = document.getElementById("totalWaitingCount");
    const emergencyCountEl = document.getElementById("emergencyCount");

    if (totalCountEl) totalCountEl.innerText = totalWaiting;
    if (emergencyCountEl) emergencyCountEl.innerText = highPriorityCount;
}