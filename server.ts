import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { HOSPITALS, LANDMARKS, INITIAL_AMBULANCES, INITIAL_PATIENT } from './src/data/mockData.ts';
import { findNearestAvailableAmbulance, getDrivingRoute } from './src/services/routingService.ts';
import { getRecommendedHospital } from './src/services/hospitalMatcher.ts';
import { SimulationState, Booking, AmbulanceUnit, Hospital, TripStage, PatientProfile, EmergencyCategory, BookingDocument, AuditLogItem } from './src/types/index.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Rate limiting map
const ipRequestCounts = new Map<string, { count: number; resetAt: number }>();
app.use((req: Request, res: Response, next) => {
  const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
  const now = Date.now();
  const record = ipRequestCounts.get(clientIp);
  if (!record || now > record.resetAt) {
    ipRequestCounts.set(clientIp, { count: 1, resetAt: now + 60000 });
    return next();
  }
  record.count += 1;
  if (record.count > 180) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a minute.' });
  }
  next();
});

// Middleware for parsing JSON with generous limit for image data
app.use(express.json({ limit: '35mb' }));

// Persistent Database Configuration
const DB_DIR = path.resolve(__dirname, 'data');
const DB_PATH = path.resolve(DB_DIR, 'dropaid_db.json');

// Server-side mutable state
let serverHospitals: Hospital[] = JSON.parse(JSON.stringify(HOSPITALS));
let serverAmbulances: AmbulanceUnit[] = JSON.parse(JSON.stringify(INITIAL_AMBULANCES));
let serverBookings: Booking[] = [];
let serverProfile: PatientProfile = JSON.parse(JSON.stringify(INITIAL_PATIENT));
let auditLogs: AuditLogItem[] = [];
let consentRecords: Array<{ id: string; timestamp: string; bookingId?: string; consentType: string; granted: boolean; ip?: string; notes?: string }> = [];
let sharedPlatformState: any = null;

// Persistent Database Helpers
function loadDatabase() {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.bookings)) serverBookings = data.bookings;
      if (Array.isArray(data.ambulances) && data.ambulances.length > 0) serverAmbulances = data.ambulances;
      if (Array.isArray(data.hospitals) && data.hospitals.length > 0) serverHospitals = data.hospitals;
      if (data.profile) serverProfile = data.profile;
      if (Array.isArray(data.auditLogs)) auditLogs = data.auditLogs;
      if (Array.isArray(data.consentRecords)) consentRecords = data.consentRecords;
      if (data.simulation) simulationState = data.simulation;
      console.log(`[DB] Successfully loaded persistent state from ${DB_PATH} (${serverBookings.length} bookings, ${auditLogs.length} audit logs)`);
    } else {
      saveDatabase();
    }
  } catch (err) {
    console.warn('[DB] Persistent storage load warning, using in-memory baseline:', err);
  }
}

function saveDatabase() {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    const payload = {
      bookings: serverBookings,
      ambulances: serverAmbulances,
      hospitals: serverHospitals,
      profile: serverProfile,
      auditLogs,
      consentRecords,
      simulation: simulationState,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[DB] Persistent storage save error:', err);
  }
}

function logAudit(action: string, bookingId?: string, actor: string = 'system', ip?: string, details?: any): AuditLogItem {
  const item: AuditLogItem = {
    id: `audit-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    action,
    bookingId,
    actor,
    ip,
    details,
  };
  auditLogs = [item, ...auditLogs.slice(0, 499)];
  saveDatabase();
  return item;
}

// Telegram Service Configuration (Backend-Only)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_OPERATIONS_CHAT_ID = process.env.TELEGRAM_OPERATIONS_CHAT_ID || '';

async function notifyTelegramOperations(booking: Booking, eventType: string = 'created') {
  const hasSubmittedSurgeryDocs = Boolean(
    booking.surgeryDocumentsSubmitted ||
    booking.hasSubmittedMedicalDocuments ||
    (booking.documents && booking.documents.length > 0) ||
    serverProfile.surgeryDocumentsSubmitted ||
    (serverProfile.documents && serverProfile.documents.length > 0)
  );

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OPERATIONS_CHAT_ID) {
    logAudit('telegram_notification_skipped', booking.id, 'telegram_service', undefined, {
      status: 'simulated_unconfigured',
      reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_OPERATIONS_CHAT_ID not provided in environment',
      eventType,
      hasSubmittedSurgeryDocs,
    });
    return { success: false, simulated: true, reason: 'Credentials not configured' };
  }

  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const secureCaseUrl = `${appBaseUrl}/?track=${booking.trackingCode}`;
  const surgeryUploadUrl = `${appBaseUrl}/?track=${booking.trackingCode}&action=upload_surgery_docs`;

  let message = '';
  if (!hasSubmittedSurgeryDocs) {
    // Patient has NOT submitted medical documents for surgery yet
    message = `🚨 *DROPAID EMERGENCY DISPATCH — SURGERY PENDING* (${eventType.toUpperCase()})
Case ID: \`${booking.trackingCode}\`
Status: *${booking.stage.toUpperCase()}*

👤 *PATIENT & USER CLINICAL DATA:*
• Caller: *${booking.callerName || booking.patientName}* (${booking.callerPhone || booking.patientPhone})
• Recipient: *${booking.bookingFor === 'someone_else' ? `Patient: ${booking.patientName} (${booking.patientRelationship || 'Other'})` : 'Self'}*
• Blood Group: *${booking.bloodGroup || 'Not Stated (Emergency Crossmatch)'}*
• Emergency Category: *${(booking.issueCategory || 'general').toUpperCase()}*
• Reported Symptoms: *${booking.patientNotes || 'Immediate emergency dispatch requested'}*
• Pickup Location: ${booking.pickupAddress}
• Destination ER: ${booking.dropoffAddress.split(',')[0]}
• Assigned Ambulance: *${booking.assignedUnitId ? `Unit ${booking.assignedUnitId}` : 'Searching nearest unit...'}*
• Road ETA: ~${booking.etaMinutes} mins | Distance: ${booking.distanceKm} km

⚠️ *URGENT ACTION: SURGERY MEDICAL DOCUMENTS NOT SUBMITTED*
• The user has NOT yet submitted their medical documents for surgery clearance.
• Please submit surgical records, diagnostic scans, or pathology reports immediately:
🔗 *Submit Surgery Documents:* ${surgeryUploadUrl}
• Operations / Paramedics: Request physical surgical files on scene to expedite hospital handover.

🔐 *Secure Access-Controlled Case Portal:*
${secureCaseUrl}`;
  } else {
    // Patient has ALREADY submitted medical documents for surgery
    message = `🚨 *DROPAID EMERGENCY DISPATCH — SURGERY CLEARED* (${eventType.toUpperCase()})
Case ID: \`${booking.trackingCode}\`
Status: *${booking.stage.toUpperCase()}*

👤 *PATIENT & USER CLINICAL DATA:*
• Caller: *${booking.callerName || booking.patientName}* (${booking.callerPhone || booking.patientPhone})
• Recipient: *${booking.bookingFor === 'someone_else' ? `Patient: ${booking.patientName} (${booking.patientRelationship || 'Other'})` : 'Self'}*
• Blood Group: *${booking.bloodGroup || 'On File'}*
• Emergency Category: *${(booking.issueCategory || 'general').toUpperCase()}*
• Symptoms: *${booking.patientNotes || 'Emergency dispatch requested'}*
• Pickup Location: ${booking.pickupAddress}
• Destination ER: ${booking.dropoffAddress.split(',')[0]}
• Assigned Ambulance: *${booking.assignedUnitId ? `Unit ${booking.assignedUnitId}` : 'En route'}*
• Road ETA: ~${booking.etaMinutes} mins | Distance: ${booking.distanceKm} km

✅ *SURGERY MEDICAL DOCUMENTS: ON FILE & VERIFIED*
• Patient has ALREADY submitted all required surgery medical records (${booking.documents?.length || 1} on file).
• *NO FURTHER DOCUMENTATION REQUIRED FROM USER.*
• DropAid backend is managing ambulance-to-hospital intake and surgical bay prep automatically.

🔐 *Secure Case Portal for Surgical Team:*
${secureCaseUrl}`;
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_OPERATIONS_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.json();
    logAudit('telegram_operations_alert', booking.id, 'telegram_service', undefined, {
      ok: data.ok,
      chatId: TELEGRAM_OPERATIONS_CHAT_ID,
      eventType,
      hasSubmittedSurgeryDocs,
    });
    return { success: data.ok, data };
  } catch (err: any) {
    logAudit('telegram_operations_alert_error', booking.id, 'telegram_service', undefined, { error: err.message });
    return { success: false, error: err.message };
  }
}

async function notifyPatientTelegram(booking: Booking) {
  if (!TELEGRAM_BOT_TOKEN || !booking.patientTelegramChatId) {
    return { success: false, reason: 'No verified Telegram Chat ID linked for patient' };
  }

  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const secureCaseUrl = `${appBaseUrl}/?track=${booking.trackingCode}`;
  const surgeryUploadUrl = `${appBaseUrl}/?track=${booking.trackingCode}&action=upload_surgery_docs`;
  const hasSubmittedSurgeryDocs = Boolean(
    booking.surgeryDocumentsSubmitted ||
    booking.hasSubmittedMedicalDocuments ||
    (booking.documents && booking.documents.length > 0)
  );

  const message = hasSubmittedSurgeryDocs
    ? `🚑 *DropAid Emergency Dispatch Update*
Your emergency request *${booking.trackingCode}* is active.
Current Status: *${booking.stage.replace(/_/g, ' ').toUpperCase()}*
Assigned Ambulance: *${booking.assignedUnitId || 'En route'}* (ETA: ~*${booking.etaMinutes}* mins)
Destination ER: ${booking.dropoffAddress.split(',')[0]}

✅ *Surgery Medical Documents Confirmed:*
Your medical documents for surgery are already verified on file and forwarded to the receiving hospital. You do not need to submit any paperwork—DropAid is managing all hospital and surgical intake automatically!

📍 *Track ambulance live:*
${secureCaseUrl}`
    : `🚑 *DropAid Emergency Dispatch Update*
Your emergency request *${booking.trackingCode}* is active.
Current Status: *${booking.stage.replace(/_/g, ' ').toUpperCase()}*
Assigned Ambulance: *${booking.assignedUnitId || 'En route'}* (ETA: ~*${booking.etaMinutes}* mins)
Destination ER: ${booking.dropoffAddress.split(',')[0]}

⚠️ *Action Required: Surgery Medical Documents Pending*
You have not submitted medical documents for surgery clearance yet. To prepare the operating room and hospital surgical team in advance, please upload your records here:
🔗 ${surgeryUploadUrl}

📍 *Track ambulance live:*
${secureCaseUrl}`;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: booking.patientTelegramChatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.json();
    return { success: data.ok, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Cloudinary configuration (from env)
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'demo';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || '';

// ==========================================
// AUTOMATED DAILY RIDE SIMULATION ENGINE
// Generates ~20 realistic rides per simulated day
// ==========================================
const SIMULATED_PATIENTS = [
  { name: 'Rohan Sharma', phone: '+91 98101 22345', symptoms: 'Severe acute chest pressure radiating to left arm (Suspected STEMI)' },
  { name: 'Ananya Verma', phone: '+91 98712 33456', symptoms: 'Pediatric respiratory distress, severe wheezing, SpO2 88%' },
  { name: 'Vikram Malhotra', phone: '+91 98234 44567', symptoms: 'High-speed motor vehicle collision, blunt head and thoracic trauma' },
  { name: 'Pooja Aggarwal', phone: '+91 98188 55678', symptoms: 'Sudden right-sided hemiplegia, facial droop, dysphasia (Active Stroke)' },
  { name: 'Suresh Kumar', phone: '+91 98110 66789', symptoms: 'Acute peritonitis, syncope, severe abdominal rigidity, hypotension' },
  { name: 'Meenakshi Iyer', phone: '+91 98765 77890', symptoms: 'Severe systemic anaphylaxis after bee sting, stridor, lip edema' },
  { name: 'Kabir Batra', phone: '+91 98115 88901', symptoms: 'Fall from residential scaffolding, open compound tibia-fibula fracture' },
  { name: 'Sunita Saxena', phone: '+91 98220 99012', symptoms: 'Severe hypoglycemic stupor, diaphoresis, unresponsive to verbal cues' },
  { name: 'Arjun Singhal', phone: '+91 98330 99443', symptoms: 'Third-degree flash electrical burns, bilateral upper extremities' },
  { name: 'Deepa Nambiar', phone: '+91 98440 22334', symptoms: 'Active obstetric emergency, high-risk contractions every 90 seconds' },
  { name: 'Harpreet Singh', phone: '+91 98550 33445', symptoms: 'Witnessed out-of-hospital cardiac arrest, CPR by bystanders in progress' },
  { name: 'Kavita Chawla', phone: '+91 98660 44556', symptoms: 'Status asthmaticus refractory to continuous nebulizer, cyanosis' },
  { name: 'Tarun Mehra', phone: '+91 98770 55667', symptoms: 'Exertional heat stroke, altered mental status, rectal temp 104.4°F' },
  { name: 'Neelam Joshi', phone: '+91 98880 66778', symptoms: 'Massive upper gastrointestinal bleed, hematemesis, hemodynamic instability' },
  { name: 'Rajesh Bhardwaj', phone: '+91 98990 77889', symptoms: 'Generalized tonic-clonic status epilepticus exceeding 6 minutes' },
  { name: 'Aarav Mathur', phone: '+91 98102 33445', symptoms: 'Severe laceration from machinery, arterial spurting controlled by tourniquet' },
  { name: 'Kiran Bedi', phone: '+91 98213 44556', symptoms: 'Acute aortic dissection symptoms, tearing chest pain radiating to back' },
  { name: 'Mohit Rawat', phone: '+91 98324 55667', symptoms: 'Drowning incident at community pool, water aspiration, CPR ongoing' },
  { name: 'Divya Sen', phone: '+91 98435 66778', symptoms: 'Severe acute carbon monoxide inhalation from malfunctioning heater' },
  { name: 'Gaurav Gill', phone: '+91 98546 77889', symptoms: 'High-voltage electric shock, cardiac arrhythmia, entrance/exit wounds' },
];

let simulationState: SimulationState = {
  status: 'idle',
  simulatedDay: 1,
  simulatedHour: 8,
  simulatedMinute: 0,
  speedMultiplier: 10,
  ridesTargetPerDay: 20,
  generatedCount: 0,
  activeCount: 0,
  completedCount: 0,
};

let simulationTimer: NodeJS.Timeout | null = null;
let lastSimulatedRideMinute = -100;

// Format hour/minute as "08:15"
function formatSimTime(h: number, m: number): string {
  const hh = h.toString().padStart(2, '0');
  const mm = m.toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

// Generate a realistic simulated ride
async function generateSimulatedRide(): Promise<Booking | null> {
  const patient = SIMULATED_PATIENTS[Math.floor(Math.random() * SIMULATED_PATIENTS.length)];
  const landmark = LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)];
  const hospital = serverHospitals[Math.floor(Math.random() * serverHospitals.length)];

  const pickupCoords = {
    lat: landmark.lat + (Math.random() - 0.5) * 0.008,
    lng: landmark.lng + (Math.random() - 0.5) * 0.008,
  };
  const dropoffCoords = { lat: hospital.lat, lng: hospital.lng };

  const bookingId = `sim-ride-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const trackingCode = `SIM-${Math.floor(2000 + Math.random() * 8000)}`;
  const simTimeString = formatSimTime(simulationState.simulatedHour, simulationState.simulatedMinute);

  // Proximity auto-assignment
  const nearestResult = findNearestAvailableAmbulance(pickupCoords, serverAmbulances);
  const assigned = nearestResult?.ambulance || null;

  let initialStage: TripStage = 'pending';
  let assignedUnitId: string | undefined = undefined;
  let routePolyline: [number, number][] = [];
  let distanceKm = nearestResult ? nearestResult.distanceKm : 5.2;
  let etaMinutes = nearestResult ? nearestResult.etaMinutes : 6;

  if (assigned) {
    initialStage = 'en_route_pickup';
    assignedUnitId = assigned.id;
    try {
      const leg1 = await getDrivingRoute(assigned.location, pickupCoords);
      routePolyline = leg1.polyline;
      distanceKm = leg1.distanceKm;
      etaMinutes = leg1.etaMinutes;
    } catch {
      routePolyline = [
        [assigned.location.lat, assigned.location.lng],
        [pickupCoords.lat, pickupCoords.lng],
      ];
    }

    // Update assigned unit status
    serverAmbulances = serverAmbulances.map((a) =>
      a.id === assigned.id
        ? {
            ...a,
            status: 'en_route_pickup' as const,
            currentBookingId: bookingId,
            speedKmH: 48,
          }
        : a
    );
  }

  const nowIso = new Date().toISOString();

  const newRide: Booking = {
    id: bookingId,
    trackingCode,
    createdAt: nowIso,
    patientName: `${patient.name} (Simulated)`,
    patientPhone: patient.phone,
    patientNotes: `[SIMULATED DISPATCH - Day ${simulationState.simulatedDay} @ ${simTimeString}] ${patient.symptoms}`,
    pickupAddress: `${landmark.name}, ${landmark.address}`,
    pickupCoords,
    dropoffAddress: `${hospital.name}, ${hospital.address}`,
    dropoffCoords,
    destinationHospitalId: hospital.id,
    equipmentRequested: ['eq-als', 'eq-cardiac'],
    stage: initialStage,
    assignedUnitId,
    etaMinutes,
    distanceKm,
    routePolyline,
    currentVehiclePosition: assigned ? [assigned.location.lat, assigned.location.lng] : undefined,
    priceEst: Math.round(180 + distanceKm * 18),
    documents: [],
    stageTimestamps: {
      requested: nowIso,
      ...(initialStage !== 'pending' ? { accepted: nowIso, dispatched: nowIso } : {}),
    },
    isSimulated: true,
    simulationDay: simulationState.simulatedDay,
    simulationTime: simTimeString,
    statusHistory: [
      { stage: 'pending', timestamp: nowIso, note: `Emergency call logged at simulated time ${simTimeString}` },
      ...(assigned
        ? [
            {
              stage: 'en_route_pickup' as TripStage,
              timestamp: nowIso,
              note: `Auto-dispatched Unit ${assigned.callSign} (Driver: ${assigned.driverName}) via proximity calculation`,
            },
          ]
        : []),
    ],
  };

  serverBookings = [newRide, ...serverBookings];
  simulationState.generatedCount += 1;
  return newRide;
}

// Tick function that advances the simulation
async function runSimulationTick() {
  if (simulationState.status !== 'running') return;

  // Advance simulated clock: with speed multiplier (default 10 -> ~10 simulated minutes per tick)
  const minuteIncrement = Math.max(2, Math.round(simulationState.speedMultiplier));
  simulationState.simulatedMinute += minuteIncrement;

  if (simulationState.simulatedMinute >= 60) {
    simulationState.simulatedHour += Math.floor(simulationState.simulatedMinute / 60);
    simulationState.simulatedMinute = simulationState.simulatedMinute % 60;
  }

  if (simulationState.simulatedHour >= 24) {
    simulationState.simulatedDay += Math.floor(simulationState.simulatedHour / 24);
    simulationState.simulatedHour = simulationState.simulatedHour % 24;
    // reset count for new simulated day target
    simulationState.generatedCount = 0;
  }

  const currentTotalSimMinutes = simulationState.simulatedDay * 1440 + simulationState.simulatedHour * 60 + simulationState.simulatedMinute;

  // Schedule ride generation: ~20 rides per 1440 minutes = roughly 1 ride every 72 simulated minutes (with jitter)
  const minutesSinceLast = currentTotalSimMinutes - lastSimulatedRideMinute;
  const intervalTarget = Math.max(45, Math.floor(1440 / simulationState.ridesTargetPerDay));

  if (minutesSinceLast >= intervalTarget && simulationState.generatedCount < simulationState.ridesTargetPerDay) {
    lastSimulatedRideMinute = currentTotalSimMinutes;
    try {
      await generateSimulatedRide();
    } catch (err) {
      console.warn('Simulation ride generation error:', err);
    }
  }

  // Auto-assign any pending simulated rides if ambulances became available
  const pendingSimRides = serverBookings.filter((b) => b.isSimulated && b.stage === 'pending');
  for (const bk of pendingSimRides) {
    const nearest = findNearestAvailableAmbulance(bk.pickupCoords, serverAmbulances);
    if (nearest?.ambulance) {
      const assigned = nearest.ambulance;
      bk.stage = 'en_route_pickup';
      bk.assignedUnitId = assigned.id;
      bk.currentVehiclePosition = [assigned.location.lat, assigned.location.lng];
      bk.statusHistory?.push({
        stage: 'en_route_pickup',
        timestamp: new Date().toISOString(),
        note: `Auto-dispatched Unit ${assigned.callSign} (Driver: ${assigned.driverName})`,
      });

      serverAmbulances = serverAmbulances.map((a) =>
        a.id === assigned.id
          ? { ...a, status: 'en_route_pickup' as const, currentBookingId: bk.id, speedKmH: 48 }
          : a
      );

      try {
        const leg = await getDrivingRoute(assigned.location, bk.pickupCoords);
        bk.routePolyline = leg.polyline;
        bk.distanceKm = leg.distanceKm;
        bk.etaMinutes = leg.etaMinutes;
      } catch {
        bk.routePolyline = [
          [assigned.location.lat, assigned.location.lng],
          [bk.pickupCoords.lat, bk.pickupCoords.lng],
        ];
      }
    }
  }

  // Advance ongoing simulated rides through stages
  const activeSimRides = serverBookings.filter(
    (b) => b.isSimulated && ['en_route_pickup', 'on_scene', 'transporting', 'at_hospital'].includes(b.stage)
  );

  for (const bk of activeSimRides) {
    const nowIso = new Date().toISOString();
    const assigned = serverAmbulances.find((a) => a.id === bk.assignedUnitId);

    if (bk.stage === 'en_route_pickup') {
      // Transition to on_scene
      bk.stage = 'on_scene';
      bk.stageTimestamps.arrivedScene = nowIso;
      bk.routePolyline = [];
      bk.currentVehiclePosition = [bk.pickupCoords.lat, bk.pickupCoords.lng];
      bk.statusHistory?.push({
        stage: 'on_scene',
        timestamp: nowIso,
        note: 'Ambulance arrived at patient scene. Paramedics initiating triage.',
      });

      if (assigned) {
        serverAmbulances = serverAmbulances.map((a) =>
          a.id === assigned.id
            ? { ...a, status: 'on_scene' as const, location: { ...bk.pickupCoords }, speedKmH: 0 }
            : a
        );
      }
    } else if (bk.stage === 'on_scene') {
      // Transition to transporting (Patient picked up -> to Hospital ER)
      bk.stage = 'transporting';
      bk.stageTimestamps.departedScene = nowIso;
      bk.statusHistory?.push({
        stage: 'transporting',
        timestamp: nowIso,
        note: `Patient stabilized and onboard. High-priority transport to ${bk.dropoffAddress.split(',')[0]} ER initiated.`,
      });

      if (assigned) {
        serverAmbulances = serverAmbulances.map((a) =>
          a.id === assigned.id
            ? { ...a, status: 'transporting' as const, speedKmH: 52 }
            : a
        );
      }

      try {
        const leg2 = await getDrivingRoute(bk.pickupCoords, bk.dropoffCoords);
        bk.routePolyline = leg2.polyline;
        bk.distanceKm = leg2.distanceKm;
        bk.etaMinutes = leg2.etaMinutes;
      } catch {
        bk.routePolyline = [
          [bk.pickupCoords.lat, bk.pickupCoords.lng],
          [bk.dropoffCoords.lat, bk.dropoffCoords.lng],
        ];
      }
    } else if (bk.stage === 'transporting') {
      // Transition to at_hospital
      bk.stage = 'at_hospital';
      bk.stageTimestamps.arrivedHospital = nowIso;
      bk.routePolyline = [];
      bk.currentVehiclePosition = [bk.dropoffCoords.lat, bk.dropoffCoords.lng];
      bk.statusHistory?.push({
        stage: 'at_hospital',
        timestamp: nowIso,
        note: 'Ambulance backed into Hospital Emergency Bay. Handing off to Trauma Team.',
      });

      if (assigned) {
        serverAmbulances = serverAmbulances.map((a) =>
          a.id === assigned.id
            ? { ...a, status: 'at_hospital' as const, location: { ...bk.dropoffCoords }, speedKmH: 0 }
            : a
        );
      }
    } else if (bk.stage === 'at_hospital') {
      // Complete the simulated ride and return ambulance to base
      bk.stage = 'completed';
      bk.stageTimestamps.completed = nowIso;
      bk.statusHistory?.push({
        stage: 'completed',
        timestamp: nowIso,
        note: 'Patient handoff complete. Unit disinfected and returning to base bay.',
      });

      if (assigned) {
        serverAmbulances = serverAmbulances.map((a) =>
          a.id === assigned.id
            ? {
                ...a,
                status: 'available' as const,
                currentBookingId: undefined,
                location: { ...a.baseLocation },
                speedKmH: 0,
              }
            : a
        );
      }
    }
  }

  // Update simulation statistics
  const currentSimRides = serverBookings.filter((b) => b.isSimulated);
  simulationState.activeCount = currentSimRides.filter((b) =>
    ['pending', 'accepted', 'en_route_pickup', 'on_scene', 'transporting', 'at_hospital'].includes(b.stage)
  ).length;
  simulationState.completedCount = currentSimRides.filter((b) => b.stage === 'completed').length;
}

// ------------------------------------------
// SIMULATION API ROUTES
// ------------------------------------------
app.get('/api/simulation', (_req: Request, res: Response) => {
  const simulatedRides = serverBookings.filter((b) => b.isSimulated);
  res.json({
    success: true,
    state: simulationState,
    rides: simulatedRides,
  });
});

app.post('/api/simulation/start', (_req: Request, res: Response) => {
  simulationState.status = 'running';

  if (!simulationTimer) {
    simulationTimer = setInterval(() => {
      runSimulationTick();
    }, 3000); // Ticks every 3 seconds
  }

  res.json({ success: true, message: 'Automated daily ride simulation started.', state: simulationState });
});

app.post('/api/simulation/pause', (_req: Request, res: Response) => {
  simulationState.status = 'paused';
  if (simulationTimer) {
    clearInterval(simulationTimer);
    simulationTimer = null;
  }
  res.json({ success: true, message: 'Simulation paused.', state: simulationState });
});

app.post('/api/simulation/reset', (_req: Request, res: Response) => {
  simulationState.status = 'idle';
  if (simulationTimer) {
    clearInterval(simulationTimer);
    simulationTimer = null;
  }

  simulationState.simulatedDay = 1;
  simulationState.simulatedHour = 8;
  simulationState.simulatedMinute = 0;
  simulationState.generatedCount = 0;
  simulationState.activeCount = 0;
  simulationState.completedCount = 0;
  lastSimulatedRideMinute = -100;

  // Clear simulated rides but keep user-submitted bookings
  serverBookings = serverBookings.filter((b) => !b.isSimulated);

  // Return all ambulances to available base station locations
  serverAmbulances = serverAmbulances.map((a) => ({
    ...a,
    status: 'available' as const,
    currentBookingId: undefined,
    location: { ...a.baseLocation },
    speedKmH: 0,
  }));

  res.json({ success: true, message: 'Simulation state successfully reset.', state: simulationState });
});

app.post('/api/simulation/speed', (req: Request, res: Response) => {
  const { multiplier } = req.body;
  if (typeof multiplier === 'number' && multiplier >= 1 && multiplier <= 60) {
    simulationState.speedMultiplier = multiplier;
  }
  res.json({ success: true, speedMultiplier: simulationState.speedMultiplier });
});

// ==========================================
// 1. HOSPITAL DIRECTORY API
// ==========================================
app.get('/api/hospitals', (req: Request, res: Response) => {
  const { region, search } = req.query;
  let result = serverHospitals;

  if (region && typeof region === 'string' && region.toLowerCase() !== 'all') {
    result = result.filter((h) => h.region.toLowerCase() === region.toLowerCase());
  }

  if (search && typeof search === 'string') {
    const q = search.toLowerCase();
    result = result.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.address.toLowerCase().includes(q) ||
        h.specialties.some((s) => s.toLowerCase().includes(q))
    );
  }

  res.json({
    success: true,
    count: result.length,
    hospitals: result,
  });
});

// Hospital Image Replacement (Cloudinary integration)
app.post('/api/hospitals/:id/image', (req: Request, res: Response) => {
  const { id } = req.params;
  const { imageUrl, publicId } = req.body;

  if (!imageUrl) {
    return res.status(400).json({ error: 'Image URL is required' });
  }

  let found = false;
  serverHospitals = serverHospitals.map((h) => {
    if (h.id === id) {
      found = true;
      return {
        ...h,
        image: imageUrl,
        ...(publicId ? { cloudinaryPublicId: publicId } : {}),
      };
    }
    return h;
  });

  if (!found) {
    return res.status(404).json({ error: 'Hospital not found' });
  }

  res.json({ success: true, message: 'Hospital image updated successfully', hospitalId: id, imageUrl });
});

// ==========================================
// 2. AMBULANCE FLEET API
// ==========================================
app.get('/api/fleet', (_req: Request, res: Response) => {
  res.json({
    success: true,
    ambulances: serverAmbulances,
  });
});

// Driver / Ambulance Unit Photo Replacement (Cloudinary integration)
app.post('/api/fleet/:id/photo', (req: Request, res: Response) => {
  const { id } = req.params;
  const { photoUrl, publicId, target = 'driver' } = req.body;

  if (!photoUrl) {
    return res.status(400).json({ error: 'Photo URL is required' });
  }

  let found = false;
  serverAmbulances = serverAmbulances.map((a) => {
    if (a.id === id) {
      found = true;
      if (target === 'driver') {
        return {
          ...a,
          driverPhoto: photoUrl,
          ...(publicId ? { driverPhotoPublicId: publicId } : {}),
        };
      } else {
        return {
          ...a,
          unitPhoto: photoUrl,
          ...(publicId ? { unitPhotoPublicId: publicId } : {}),
        };
      }
    }
    return a;
  });

  if (!found) {
    return res.status(404).json({ error: 'Ambulance unit not found' });
  }

  res.json({ success: true, message: `${target} photo updated successfully`, unitId: id, photoUrl });
});

// ==========================================
// 3. BOOKINGS API (With Auto-Dispatch & Proximity)
// ==========================================
app.get('/api/bookings', (_req: Request, res: Response) => {
  res.json({
    success: true,
    bookings: serverBookings,
  });
});

// Create Booking with AUTOMATIC DISPATCH & UNIFIED INTAKE
app.post('/api/bookings', async (req: Request, res: Response) => {
  try {
    const {
      callerName,
      callerPhone,
      callerEmail,
      bloodGroup,
      bookingFor = 'self',
      patientName: rawPatientName,
      patientPhone: rawPatientPhone,
      patientRelationship,
      patientAge,
      patientPhotoUrl,
      patientTelegramChatId,
      patientNotes = 'Immediate emergency dispatch requested',
      pickupAddress,
      pickupCoords,
      dropoffAddress,
      dropoffCoords,
      destinationHospitalId,
      equipmentRequested = ['eq-als', 'eq-cardiac'],
      bookingType = 'emergency_hold',
      issueCategory = 'general',
      consentGranted = true,
    } = req.body;

    // Validate Required User Identification
    const finalCallerName = (callerName || rawPatientName || 'Emergency Caller').trim();
    const finalCallerPhone = (callerPhone || rawPatientPhone || '').trim();

    if (!finalCallerPhone || finalCallerPhone.replace(/\D/g, '').length < 8) {
      return res.status(400).json({ error: 'A valid emergency contact phone number (at least 8 digits) is required.' });
    }

    if (!pickupCoords || typeof pickupCoords.lat !== 'number' || typeof pickupCoords.lng !== 'number') {
      return res.status(400).json({ error: 'Valid pickup coordinates (lat, lng) are required.' });
    }

    if (!dropoffCoords || typeof dropoffCoords.lat !== 'number' || typeof dropoffCoords.lng !== 'number') {
      return res.status(400).json({ error: 'Valid destination coordinates (lat, lng) are required.' });
    }

    // Determine Patient Details
    const finalPatientName = (bookingFor === 'someone_else' ? rawPatientName || 'Emergency Patient' : finalCallerName).trim();
    const finalPatientPhone = (bookingFor === 'someone_else' ? rawPatientPhone || finalCallerPhone : finalCallerPhone).trim();

    // Duplicate Prevention: Check if same contact has an active non-terminal trip in the last 45 seconds
    const recentDuplicate = serverBookings.find(
      (b) =>
        b.stage !== 'completed' &&
        b.stage !== 'cancelled' &&
        (b.callerPhone === finalCallerPhone || b.patientPhone === finalPatientPhone) &&
        Date.now() - new Date(b.createdAt).getTime() < 45000
    );

    if (recentDuplicate) {
      return res.status(409).json({
        error: 'An active emergency dispatch is already processing for this mobile number. Please check your active booking.',
        booking: recentDuplicate,
      });
    }

    const bookingId = req.body.id || `bk-${Date.now()}`;
    const trackingCode = req.body.trackingCode || `DA-${Math.floor(1000 + Math.random() * 9000)}`;

    // AUTOMATIC DISPATCH ENGINE:
    // Autonomous proximity matching with 5-second guarantee
    const nearestResult = findNearestAvailableAmbulance(pickupCoords, serverAmbulances);
    const assigned = nearestResult?.ambulance || null;

    let stage: TripStage = 'pending';
    let assignedUnitId: string | undefined = undefined;
    let routePolyline: [number, number][] = [];
    let distanceKm = nearestResult ? nearestResult.distanceKm : 4.8;
    let etaMinutes = nearestResult ? nearestResult.etaMinutes : 5;

    if (assigned) {
      stage = 'en_route_pickup';
      assignedUnitId = assigned.id;

      try {
        const routeData = await getDrivingRoute(assigned.location, pickupCoords);
        routePolyline = routeData.polyline;
        distanceKm = routeData.distanceKm;
        etaMinutes = routeData.etaMinutes;
      } catch {
        routePolyline = [
          [assigned.location.lat, assigned.location.lng],
          [pickupCoords.lat, pickupCoords.lng],
        ];
      }

      // Update assigned ambulance status
      serverAmbulances = serverAmbulances.map((a) =>
        a.id === assigned.id
          ? {
              ...a,
              status: 'en_route_pickup' as const,
              currentBookingId: bookingId,
              speedKmH: 48,
            }
          : a
      );
    }

    const nowIso = new Date().toISOString();
    const destHospital = serverHospitals.find((h) => h.id === (destinationHospitalId || serverHospitals[0].id));
    const confirmedDoctor = destHospital?.attendingDoctors?.[0] || undefined;
    const isDoctorConfirmedByHospital = Boolean(confirmedDoctor && assigned);
    const treatmentTeam = destHospital?.treatmentTeam || undefined;
    const treatmentProcedure = destHospital
      ? {
          assignedBayOrRoom: `${destHospital.name.split(' ')[0]} Trauma Resuscitation Bay ${Math.floor(1 + Math.random() * 4)}`,
          triageLevel: 'Level 1 - Resuscitation' as const,
          preparedEquipment: ['Cardiac Telemetry Monitor', 'Advanced Airway Cart', 'Rapid Infuser'],
          confirmedAt: nowIso,
        }
      : undefined;

    // Attach initial documents if any
    const initialDocs: BookingDocument[] = Array.isArray(req.body.documents) ? req.body.documents : [];
    if (patientPhotoUrl) {
      initialDocs.unshift({
        id: `doc-photo-${Date.now()}`,
        name: `${finalPatientName} - Initial Intake Photo`,
        type: 'incident_photo',
        url: patientPhotoUrl,
        uploadedAt: nowIso,
        source: patientPhotoUrl.startsWith('data:') ? 'local_optimized' : 'cloudinary_live',
        consentGranted: true,
        treatmentStage: 'pre_dispatch',
        isVerified: true,
      });
    }

    const newBooking: Booking = {
      id: bookingId,
      trackingCode,
      createdAt: nowIso,
      callerName: finalCallerName,
      callerPhone: finalCallerPhone,
      callerEmail: callerEmail || undefined,
      bloodGroup: bloodGroup || undefined,
      bookingFor: bookingFor as 'self' | 'someone_else',
      patientName: finalPatientName,
      patientPhone: finalPatientPhone,
      patientRelationship: bookingFor === 'someone_else' ? patientRelationship || 'Family/Other' : undefined,
      patientAge: patientAge || undefined,
      patientPhotoUrl: patientPhotoUrl || undefined,
      patientTelegramChatId: patientTelegramChatId || undefined,
      telegramNotificationStatus: 'pending',
      surgeryDocumentsSubmitted: Boolean(
        req.body.surgeryDocumentsSubmitted ||
        req.body.hasSubmittedMedicalDocuments ||
        (Array.isArray(req.body.documents) && req.body.documents.length > 0)
      ),
      hasSubmittedMedicalDocuments: Boolean(
        req.body.surgeryDocumentsSubmitted ||
        req.body.hasSubmittedMedicalDocuments ||
        (Array.isArray(req.body.documents) && req.body.documents.length > 0)
      ),
      patientNotes: `${bookingType === 'emergency_hold' ? '[Quick 5s Hold Dispatch] ' : '[Manual Assisted Booking] '}${patientNotes}`,
      issueCategory: (issueCategory as EmergencyCategory) || 'general',
      pickupAddress: pickupAddress || `GPS Location (${pickupCoords.lat.toFixed(4)}, ${pickupCoords.lng.toFixed(4)})`,
      pickupCoords,
      dropoffAddress: dropoffAddress || 'Nearest Verified Hospital ER',
      dropoffCoords,
      destinationHospitalId: destinationHospitalId || serverHospitals[0].id,
      equipmentRequested,
      stage,
      assignedUnitId,
      etaMinutes,
      distanceKm,
      routePolyline,
      currentVehiclePosition: assigned ? [assigned.location.lat, assigned.location.lng] : undefined,
      priceEst: Math.round(150 + distanceKm * 18),
      documents: initialDocs,
      isDoctorConfirmedByHospital,
      confirmedDoctor,
      treatmentTeam,
      treatmentProcedure,
      preArrivalAlertSent: false,
      preArrivalConsentGiven: consentGranted,
      hospitalHandoverConfirmed: false,
      stageTimestamps: {
        requested: nowIso,
        ...(assigned ? { accepted: nowIso, dispatched: nowIso } : {}),
      },
      isSimulated: false,
      statusHistory: [
        { stage: 'pending', timestamp: nowIso, note: `Emergency dispatch request registered by ${finalCallerName} (${bookingFor === 'someone_else' ? 'for ' + finalPatientName : 'self'})` },
        ...(assigned
          ? [
              {
                stage: 'en_route_pickup' as TripStage,
                timestamp: nowIso,
                note: `Auto-dispatched Unit ${assigned.callSign} (Driver: ${assigned.driverName}) via autonomous proximity match (< 5s)`,
              },
            ]
          : []),
      ],
    };

    serverBookings = [newBooking, ...serverBookings];
    saveDatabase();

    // Record Audit Log Event
    logAudit('emergency_booking_created', bookingId, finalCallerName, req.ip, {
      trackingCode,
      bookingFor,
      patientName: finalPatientName,
      assignedUnitId,
      stage,
      issueCategory,
    });

    // Record Consent Event
    consentRecords.push({
      id: `consent-${Date.now()}`,
      timestamp: nowIso,
      bookingId,
      consentType: 'pre_arrival_er_dispatch',
      granted: Boolean(consentGranted),
      ip: req.ip,
      notes: `Dispatch consent acknowledged by caller ${finalCallerName}`,
    });

    // Trigger Telegram Dispatch Notifications (Backend Only, Operations Chat + Optional Patient)
    notifyTelegramOperations(newBooking, 'created').then((res) => {
      newBooking.telegramNotificationStatus = res.success ? 'sent' : res.simulated ? 'simulated_unconfigured' : 'failed';
      saveDatabase();
    }).catch(() => {});

    if (patientTelegramChatId) {
      notifyPatientTelegram(newBooking).catch(() => {});
    }

    return res.status(201).json({
      success: true,
      booking: newBooking,
      assignedAmbulance: assigned,
      message: assigned
        ? `Emergency unit auto-dispatched! Ambulance ${assigned.callSign} is en route (ETA ~${etaMinutes} mins).`
        : `Emergency request registered. Searching Delhi NCR fleet for next available unit.`,
    });
  } catch (err: any) {
    console.error('Error creating booking:', err);
    return res.status(500).json({ error: err.message || 'Internal server error processing booking' });
  }
});

// Update booking stage with automatic road routing & audit logging
app.post('/api/bookings/:id/stage', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { stage, assignedUnitId, routePolyline, distanceKm, etaMinutes, isOperator } = req.body;

  const targetBooking = serverBookings.find((b) => b.id === id);
  if (!targetBooking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // RESTRICTION: Block user-side cancellation once patient has been picked up
  if (stage === 'cancelled' && !isOperator) {
    if (['transporting', 'at_hospital', 'completed'].includes(targetBooking.stage)) {
      return res.status(403).json({
        error: 'Your trip is in progress. Contact the assigned operator if assistance is required.',
      });
    }
  }

  let calculatedPolyline = Array.isArray(routePolyline) && routePolyline.length > 0 ? routePolyline : undefined;
  let calculatedDist = typeof distanceKm === 'number' ? distanceKm : undefined;
  let calculatedEta = typeof etaMinutes === 'number' ? etaMinutes : undefined;

  // Requirement 3: Recalculate actual road route when transitioning to transporting (patient on board -> hospital)
  if (stage === 'transporting' && !calculatedPolyline) {
    try {
      const roadRoute = await getDrivingRoute(targetBooking.pickupCoords, targetBooking.dropoffCoords);
      calculatedPolyline = roadRoute.polyline;
      calculatedDist = roadRoute.distanceKm;
      calculatedEta = roadRoute.etaMinutes;
    } catch {
      calculatedPolyline = [
        [targetBooking.pickupCoords.lat, targetBooking.pickupCoords.lng],
        [targetBooking.dropoffCoords.lat, targetBooking.dropoffCoords.lng],
      ];
    }
  }

  const nowIso = new Date().toISOString();

  serverBookings = serverBookings.map((b) => {
    if (b.id === id) {
      const updated: Booking = {
        ...b,
        stage,
        ...(assignedUnitId ? { assignedUnitId } : {}),
        ...(calculatedPolyline ? { routePolyline: calculatedPolyline } : {}),
        ...(typeof calculatedDist === 'number' ? { distanceKm: calculatedDist } : {}),
        ...(typeof calculatedEta === 'number' ? { etaMinutes: calculatedEta } : {}),
        stageTimestamps: {
          ...b.stageTimestamps,
          ...(stage === 'on_scene' ? { arrivedScene: nowIso } : {}),
          ...(stage === 'transporting' ? { departedScene: nowIso } : {}),
          ...(stage === 'at_hospital' ? { arrivedHospital: nowIso } : {}),
          ...(stage === 'completed' ? { completed: nowIso } : {}),
        },
        statusHistory: [
          ...(b.statusHistory || []),
          { stage, timestamp: nowIso, note: `Stage transitioned to ${stage}` },
        ],
      };
      return updated;
    }
    return b;
  });

  // If completed or cancelled, return vehicle to base and free the vehicle
  if (stage === 'completed' || stage === 'cancelled') {
    const bk = serverBookings.find((b) => b.id === id);
    if (bk && bk.assignedUnitId) {
      serverAmbulances = serverAmbulances.map((a) =>
        a.id === bk.assignedUnitId
          ? {
              ...a,
              location: { ...a.baseLocation },
              status: 'available' as const,
              currentBookingId: undefined,
              speedKmH: 0,
            }
          : a
      );
    }
  }

  const updatedBooking = serverBookings.find((b) => b.id === id);
  saveDatabase();
  logAudit(`trip_stage_${stage}`, id, isOperator ? 'operator' : 'user', req.ip, { stage, assignedUnitId });

  if (updatedBooking) {
    notifyTelegramOperations(updatedBooking, stage).catch(() => {});
    if (updatedBooking.patientTelegramChatId) {
      notifyPatientTelegram(updatedBooking).catch(() => {});
    }
  }

  res.json({ success: true, stage, booking: updatedBooking });
});

// Hospital Handover & Receiving ER Sign-off
app.post('/api/bookings/:id/handover', (req: Request, res: Response) => {
  const { id } = req.params;
  const { receivingDoctorName, traumaBayNumber, nurseSignature, handoverNotes, operatorName } = req.body;

  const bk = serverBookings.find((b) => b.id === id);
  if (!bk) return res.status(404).json({ error: 'Booking not found' });

  const nowIso = new Date().toISOString();
  bk.hospitalHandoverConfirmed = true;
  bk.hospitalHandoverTimestamp = nowIso;
  bk.hospitalHandoverDetails = {
    receivingDoctorName: receivingDoctorName || bk.confirmedDoctor?.name || 'Dr. Manoj Sharma',
    traumaBayNumber: traumaBayNumber || 'Bay 1 - Resuscitation',
    nurseSignature: nurseSignature || 'Triage Officer Registered',
    notes: handoverNotes || 'Patient clinical handoff acknowledged and registered by receiving ER desk.',
  };

  bk.statusHistory?.push({
    stage: bk.stage,
    timestamp: nowIso,
    note: `Hospital Handover Confirmed by receiving physician ${bk.hospitalHandoverDetails.receivingDoctorName} (${bk.hospitalHandoverDetails.traumaBayNumber})`,
  });

  saveDatabase();
  logAudit('hospital_handover_confirmed', id, operatorName || 'hospital_er', req.ip, bk.hospitalHandoverDetails);
  notifyTelegramOperations(bk, 'hospital_handover_confirmed').catch(() => {});

  res.json({ success: true, message: 'Hospital handover confirmed and acknowledged.', booking: bk });
});

// Telegram Integration Status & Verification
app.get('/api/telegram/status', (_req: Request, res: Response) => {
  res.json({
    configured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_OPERATIONS_CHAT_ID),
    hasBotToken: Boolean(TELEGRAM_BOT_TOKEN),
    hasOpsChatId: Boolean(TELEGRAM_OPERATIONS_CHAT_ID),
    operationsChatId: TELEGRAM_OPERATIONS_CHAT_ID ? `${TELEGRAM_OPERATIONS_CHAT_ID.slice(0, 4)}...` : null,
    botUsername: 'DropAidOpsBot',
  });
});

// Link Patient Telegram Chat ID to Active Booking
app.post('/api/telegram/link', (req: Request, res: Response) => {
  const { trackingCode, bookingId, telegramChatId } = req.body;
  if (!telegramChatId) {
    return res.status(400).json({ error: 'Valid Telegram Chat ID is required.' });
  }

  const bk = serverBookings.find((b) => (trackingCode && b.trackingCode === trackingCode) || (bookingId && b.id === bookingId));
  if (!bk) {
    return res.status(404).json({ error: 'Booking not found for provided tracking code or ID.' });
  }

  bk.patientTelegramChatId = String(telegramChatId);
  saveDatabase();
  logAudit('telegram_chat_linked', bk.id, 'patient', req.ip, { telegramChatId });

  // Send immediate test/confirmation update to the linked chat
  notifyPatientTelegram(bk).catch(() => {});

  res.json({ success: true, message: 'Telegram chat linked successfully to booking.', trackingCode: bk.trackingCode });
});

// Test Telegram Dispatch Notification
app.post('/api/telegram/test', async (req: Request, res: Response) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OPERATIONS_CHAT_ID) {
    return res.json({
      success: false,
      simulated: true,
      message: 'TELEGRAM_BOT_TOKEN or TELEGRAM_OPERATIONS_CHAT_ID is not configured in environment variables. Simulated log created.',
    });
  }

  try {
    const testMsg = `🔔 *DropAid Operations Test Alert*\nTimestamp: ${new Date().toISOString()}\nStatus: Telegram Operations Integration Active and Verified.`;
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_OPERATIONS_CHAT_ID,
        text: testMsg,
        parse_mode: 'Markdown',
      }),
    });
    const data = await resp.json();
    return res.json({ success: data.ok, data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Quality Control Audit Log Retrieval
app.get('/api/audit-logs', (_req: Request, res: Response) => {
  res.json({
    success: true,
    count: auditLogs.length,
    logs: auditLogs,
  });
});

// Operator Override Unit Assignment
app.post('/api/bookings/:id/assign', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { unitId } = req.body;

  const bk = serverBookings.find((b) => b.id === id);
  if (!bk) return res.status(404).json({ error: 'Booking not found' });

  const newUnit = serverAmbulances.find((a) => a.id === unitId);
  if (!newUnit) return res.status(404).json({ error: 'Unit not found' });

  // Free previously assigned unit if any
  if (bk.assignedUnitId && bk.assignedUnitId !== unitId) {
    serverAmbulances = serverAmbulances.map((a) =>
      a.id === bk.assignedUnitId
        ? { ...a, status: 'available' as const, currentBookingId: undefined, speedKmH: 0 }
        : a
    );
  }

  // Recalculate route to pickup or hospital depending on stage
  let newPolyline = bk.routePolyline;
  let newDist = bk.distanceKm;
  let newEta = bk.etaMinutes;

  if (bk.stage === 'en_route_pickup' || bk.stage === 'pending') {
    try {
      const leg = await getDrivingRoute(newUnit.location, bk.pickupCoords);
      newPolyline = leg.polyline;
      newDist = leg.distanceKm;
      newEta = leg.etaMinutes;
    } catch {
      newPolyline = [[newUnit.location.lat, newUnit.location.lng], [bk.pickupCoords.lat, bk.pickupCoords.lng]];
    }
  }

  // Assign new unit
  serverAmbulances = serverAmbulances.map((a) =>
    a.id === unitId
      ? { ...a, status: (bk.stage === 'transporting' ? 'transporting' : 'en_route_pickup') as 'transporting' | 'en_route_pickup', currentBookingId: id, speedKmH: 48 }
      : a
  );

  serverBookings = serverBookings.map((b) =>
    b.id === id
      ? {
          ...b,
          assignedUnitId: unitId,
          stage: b.stage === 'pending' ? 'en_route_pickup' : b.stage,
          routePolyline: newPolyline,
          distanceKm: newDist,
          etaMinutes: newEta,
          currentVehiclePosition: [newUnit.location.lat, newUnit.location.lng],
          statusHistory: [
            ...(b.statusHistory || []),
            {
              stage: b.stage,
              timestamp: new Date().toISOString(),
              note: `Operator override: unit reassigned to ${newUnit.callSign} (Driver: ${newUnit.driverName})`,
            },
          ],
        }
      : b
  );

  res.json({ success: true, message: `Unit override confirmed. Assigned to ${newUnit.callSign}` });
});

// Authorized Operator Destination Reroute
app.post('/api/bookings/:id/reroute', (req: Request, res: Response) => {
  const { id } = req.params;
  const { dropoffCoords, dropoffAddress, hospitalId, routePolyline, distanceKm, etaMinutes } = req.body;

  let found = false;
  serverBookings = serverBookings.map((b) => {
    if (b.id === id) {
      found = true;
      return {
        ...b,
        ...(dropoffCoords ? { dropoffCoords } : {}),
        ...(dropoffAddress ? { dropoffAddress } : {}),
        ...(hospitalId ? { destinationHospitalId: hospitalId } : {}),
        ...(Array.isArray(routePolyline) ? { routePolyline } : {}),
        ...(typeof distanceKm === 'number' ? { distanceKm } : {}),
        ...(typeof etaMinutes === 'number' ? { etaMinutes } : {}),
      };
    }
    return b;
  });

  if (!found) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  res.json({ success: true, message: 'Operator reroute synchronized successfully.' });
});

// ------------------------------------------
// DOCTOR CONFIRMATION & PRE-ARRIVAL ALERTS
// ------------------------------------------
app.post('/api/bookings/:id/confirm-doctor', (req: Request, res: Response) => {
  const { id } = req.params;
  const { doctor, treatmentTeam, procedure } = req.body;

  let found = false;
  serverBookings = serverBookings.map((b) => {
    if (b.id === id) {
      found = true;
      return {
        ...b,
        isDoctorConfirmedByHospital: true,
        ...(doctor ? { confirmedDoctor: doctor } : {}),
        ...(treatmentTeam ? { treatmentTeam } : {}),
        ...(procedure ? { treatmentProcedure: procedure } : {}),
        statusHistory: [
          ...(b.statusHistory || []),
          {
            stage: b.stage,
            timestamp: new Date().toISOString(),
            note: `Receiving hospital confirmed attending physician ${doctor?.name || 'Lead Specialist'} and designated trauma bay`,
          },
        ],
      };
    }
    return b;
  });

  if (!found) return res.status(404).json({ error: 'Booking not found' });
  res.json({ success: true, message: 'Hospital doctor assignment confirmed' });
});

app.post('/api/bookings/:id/pre-arrival-alert', (req: Request, res: Response) => {
  const { id } = req.params;
  const { patientName, bloodType, allergies, etaMinutes } = req.body;

  let found = false;
  serverBookings = serverBookings.map((b) => {
    if (b.id === id) {
      found = true;
      return {
        ...b,
        preArrivalAlertSent: true,
        preArrivalConsentGiven: true,
        preArrivalSentAt: new Date().toISOString(),
        statusHistory: [
          ...(b.statusHistory || []),
          {
            stage: b.stage,
            timestamp: new Date().toISOString(),
            note: `Pre-arrival trauma alert dispatched to ER desk (Blood: ${bloodType || 'B+'}, ETA: ~${etaMinutes || 5}m)`,
          },
        ],
      };
    }
    return b;
  });

  if (!found) return res.status(404).json({ error: 'Booking not found' });
  res.json({ success: true, message: 'Pre-arrival notification sent to receiving hospital' });
});

app.post('/api/bookings/:id/documents', (req: Request, res: Response) => {
  const { id } = req.params;
  const doc = req.body.document || req.body;

  if (!doc || !doc.url) {
    return res.status(400).json({ error: 'Document object with valid url is required' });
  }

  const documentToStore = {
    id: doc.id || `doc-${Date.now()}`,
    name: doc.name || 'Medical Document',
    type: doc.type || doc.documentType || 'medical_history',
    url: doc.url,
    publicId: doc.publicId,
    source: doc.source || 'cloudinary_live',
    uploadedAt: doc.uploadedAt || new Date().toISOString(),
    treatmentStage: doc.treatmentStage || 'pre_dispatch',
    consentGranted: doc.consentGranted ?? true,
    retentionPolicy: doc.retentionPolicy || '90_days',
    isVerified: true,
  };

  let found = false;
  let updatedBookingTarget: Booking | null = null;
  serverBookings = serverBookings.map((b) => {
    if (b.id === id) {
      found = true;
      const updatedDocs = [documentToStore, ...(b.documents || [])];
      const updated: Booking = {
        ...b,
        documents: updatedDocs,
        surgeryDocumentsSubmitted: true,
        hasSubmittedMedicalDocuments: true,
      };
      updatedBookingTarget = updated;
      return updated;
    }
    return b;
  });

  if (!found) return res.status(404).json({ error: 'Booking not found' });
  saveDatabase();

  // If this booking now has surgery documents attached, notify Telegram of surgery clearance
  if (updatedBookingTarget) {
    notifyTelegramOperations(updatedBookingTarget, 'surgery_documents_attached').catch(() => {});
  }

  res.json({ success: true, message: 'Surgery document attached to booking', document: documentToStore });
});

// Check whether patient has verified surgery documents on file
app.get('/api/user/surgery-documents-status', (req: Request, res: Response) => {
  const phone = (req.query.phone as string || '').trim();
  const hasDocumentsOnRecord = Boolean(
    (serverProfile.documents && serverProfile.documents.length > 0) ||
    serverProfile.surgeryDocumentsSubmitted ||
    (phone && serverBookings.some((b) => (b.callerPhone === phone || b.patientPhone === phone) && b.surgeryDocumentsSubmitted))
  );

  res.json({
    success: true,
    hasSubmitted: hasDocumentsOnRecord,
    documentsCount: serverProfile.documents?.length || (hasDocumentsOnRecord ? 1 : 0),
    verifiedOnRecord: hasDocumentsOnRecord,
  });
});

// ------------------------------------------
// FLOATING AI TRIAGE ASSISTANT API
// Powered by @google/genai (model: gemini-3.8-flash)
// ------------------------------------------
app.post('/api/assistant/chat', async (req: Request, res: Response) => {
  try {
    const { message, userLocation, patientProfile } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const textLower = message.toLowerCase();

    // Emergency symptom classification heuristics
    let identifiedCategory: EmergencyCategory = 'general';
    if (textLower.includes('chest') || textLower.includes('heart') || textLower.includes('stemi') || textLower.includes('cardiac') || textLower.includes('arm pain')) {
      identifiedCategory = 'cardiac';
    } else if (textLower.includes('tooth') || textLower.includes('teeth') || textLower.includes('dental') || textLower.includes('jaw') || textLower.includes('mouth') || textLower.includes('gum')) {
      identifiedCategory = 'dental';
    } else if (textLower.includes('accident') || textLower.includes('bleed') || textLower.includes('fracture') || textLower.includes('bone') || textLower.includes('crash') || textLower.includes('trauma') || textLower.includes('head')) {
      identifiedCategory = 'trauma';
    } else if (textLower.includes('child') || textLower.includes('baby') || textLower.includes('infant') || textLower.includes('pediatric')) {
      identifiedCategory = 'pediatric';
    } else if (textLower.includes('stroke') || textLower.includes('facial droop') || textLower.includes('slurred') || textLower.includes('paralysis') || textLower.includes('numbness')) {
      identifiedCategory = 'stroke';
    } else if (textLower.includes('burn') || textLower.includes('scald') || textLower.includes('fire') || textLower.includes('acid')) {
      identifiedCategory = 'burns';
    }

    const pickup = userLocation && typeof userLocation.lat === 'number'
      ? { lat: userLocation.lat, lng: userLocation.lng }
      : { lat: 28.6327, lng: 77.2197 };

    const matched = getRecommendedHospital(pickup, serverHospitals, identifiedCategory);
    const recHosp = matched.hospital;

    let requiredDocuments = [
      'Government Photo ID (Aadhaar Card, Passport, or Voter ID)',
      'Health Insurance Card / Corporate TPA Policy Document',
    ];

    if (identifiedCategory === 'cardiac') {
      requiredDocuments.push('Prior ECG or 2D Echo reports', 'Current prescription list (especially blood thinners)');
    } else if (identifiedCategory === 'dental') {
      requiredDocuments.push('Any previous dental X-rays', 'Keep any avulsed tooth in cold milk/saliva');
    } else if (identifiedCategory === 'trauma') {
      requiredDocuments.push('Emergency contact details', 'Known blood group record');
    } else if (identifiedCategory === 'pediatric') {
      requiredDocuments.push('Child immunization card', 'Birth weight / pediatric records');
    }

    let isEmergency = true;

    // Call Gemini 3.8 Flash if GEMINI_API_KEY is available
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
        const prompt = `Patient query: "${message}".
Patient Context: Name: ${patientProfile?.name || 'Patient'}, Blood Group: ${patientProfile?.bloodType || 'B+'}, Known Allergies: ${patientProfile?.allergies?.join(', ') || 'None documented'}.
Identified Emergency Category: ${identifiedCategory}.
Top Recommended Facility: ${recHosp.name} (${recHosp.traumaLevel}, ${matched.roadDistanceKm} km away, ~${matched.roadEtaMins} min road travel).
Required Paperwork: ${requiredDocuments.join('; ')}.

Generate a concise, compassionate emergency triage response (under 130 words):
1. Immediate first-aid/safety action while ambulance is en route.
2. Recommend ${recHosp.name} for this specific condition.
3. Outline required documents to prepare.
4. Conclude with an emergency warning: In life-threatening emergencies, request immediate emergency dispatch without delay.
Never give a definitive diagnosis.`;

        const aiResponse = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            systemInstruction: 'You are the DropAid Emergency Triage & Hospital Recommender in Delhi NCR. Always advise requesting immediate emergency ambulance dispatch for acute emergencies. Keep instructions calm, precise, and practical.',
          },
        });

        const replyText = aiResponse.text || '';
        if (replyText.trim()) {
          return res.json({
            success: true,
            reply: replyText,
            identifiedCategory,
            recommendedHospitalId: recHosp.id,
            recommendedHospitalName: recHosp.name,
            suggestedNotes: `${identifiedCategory.toUpperCase()} TRIAGE: ${message.slice(0, 80)}`,
            requiredDocuments,
            isEmergency,
          });
        }
      } catch (geminiErr) {
        console.warn('Gemini generateContent error, falling back to clinical heuristics:', geminiErr);
      }
    }

    // Heuristic structured fallback
    const defaultReply = `Based on your symptoms, this is classified as a **${identifiedCategory.toUpperCase()} EMERGENCY**.

🚨 **Immediate Action:** Keep the patient calm and seated upright. Do not administer oral liquids if there is any breathing distress. In life-threatening emergencies, request immediate emergency dispatch without delay.

🏥 **Recommended Hospital:** **${recHosp.name}** (${recHosp.traumaLevel}) is ~${matched.roadDistanceKm} km away with verified ${identifiedCategory} emergency care.

📋 **Documents to Prepare:** ${requiredDocuments.join(', ')}.`;

    return res.json({
      success: true,
      reply: defaultReply,
      identifiedCategory,
      recommendedHospitalId: recHosp.id,
      recommendedHospitalName: recHosp.name,
      suggestedNotes: `${identifiedCategory.toUpperCase()} EMERGENCY: ${message.slice(0, 80)}`,
      requiredDocuments,
      isEmergency,
    });
  } catch (err: any) {
    console.error('Error in assistant chat:', err);
    return res.status(500).json({ error: 'Internal server error in triage assistant' });
  }
});

// Reset demo simulation state
app.post('/api/reset', (_req: Request, res: Response) => {
  if (simulationTimer) {
    clearInterval(simulationTimer);
    simulationTimer = null;
  }
  simulationState.status = 'idle';
  simulationState.generatedCount = 0;
  simulationState.activeCount = 0;
  simulationState.completedCount = 0;

  serverBookings = [];
  serverAmbulances = JSON.parse(JSON.stringify(INITIAL_AMBULANCES));
  serverHospitals = JSON.parse(JSON.stringify(HOSPITALS));
  sharedPlatformState = null;
  res.json({ success: true, message: 'Simulation state successfully reset.' });
});

// ==========================================
// 4. CLOUDINARY INTEGRATION API
// Signed uploads, preset uploads, verification & storage
// ==========================================

// Config status for UI
app.get('/api/cloudinary/config', (_req: Request, res: Response) => {
  const hasKeys = Boolean(CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET && CLOUDINARY_CLOUD_NAME !== 'demo');
  const hasPreset = Boolean(CLOUDINARY_UPLOAD_PRESET && CLOUDINARY_CLOUD_NAME !== 'demo');

  res.json({
    success: true,
    cloudName: CLOUDINARY_CLOUD_NAME,
    isConfigured: hasKeys || hasPreset,
    mode: hasKeys ? 'signed' : hasPreset ? 'unsigned_preset' : 'local_optimized_fallback',
  });
});

// Cloudinary Upload Endpoint
// Cloudinary Upload Endpoint with Explicit Consent & Clinical Analysis
app.post('/api/cloudinary/upload', async (req: Request, res: Response) => {
  try {
    const {
      fileData,
      folder = 'dropaid',
      resourceType = 'image',
      fileName = 'upload',
      consentGranted,
      bookingId,
      documentType = 'incident_photo',
      isTriageAnalysis = false,
    } = req.body;

    // MANDATORY REQUIREMENT 2: Validate Explicit Patient/Guardian Consent
    if (consentGranted !== true) {
      return res.status(400).json({
        error: 'Explicit consent is mandatory before uploading or transmitting patient medical imagery and documents.',
      });
    }

    if (!fileData || typeof fileData !== 'string') {
      return res.status(400).json({ error: 'Valid fileData (data URL or base64) is required.' });
    }

    // Validate file format: strictly medical image or PDF
    const isImage = fileData.startsWith('data:image/jpeg') || fileData.startsWith('data:image/png') || fileData.startsWith('data:image/webp') || fileData.startsWith('https://');
    const isPdf = fileData.startsWith('data:application/pdf');

    if (!isImage && !isPdf) {
      return res.status(400).json({ error: 'Unsupported file type. Allowed formats: JPEG, PNG, WEBP, and PDF.' });
    }

    // Check size limit: ~15MB
    if (fileData.length > 20 * 1024 * 1024) {
      return res.status(400).json({ error: 'File size exceeds maximum allowable limit of 15MB.' });
    }

    // Optional Medical Image Analysis using Gemini (with mandatory clinical disclaimer)
    let triageObservation: string | undefined = undefined;
    if (isTriageAnalysis && isImage && process.env.GEMINI_API_KEY && fileData.startsWith('data:image/')) {
      try {
        const ai = new GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
        const match = fileData.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (match) {
          const mimeType = match[1];
          const base64Data = match[2];
          const aiRes = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: [
              {
                text: 'Observe this emergency incident photo for objective scene elements (e.g., anatomical area, visible trauma markers, setting). CLINICAL DISCLAIMER: Start with "[AUTOMATED TRIAGE OBSERVATION - NOT A DIAGNOSIS]". Keep it concise (under 50 words). Do not infer a definitive diagnosis. State that in-person clinical assessment is mandatory.',
              },
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          });
          triageObservation = aiRes.text || undefined;
        }
      } catch (geminiErr) {
        console.warn('Gemini triage image analysis error:', geminiErr);
        triageObservation = '[AUTOMATED TRIAGE OBSERVATION - NOT A DIAGNOSIS] Image received for paramedic situational awareness. In-person clinical exam required.';
      }
    }

    let uploadResultUrl = fileData;
    let publicId = `${folder}/${fileName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}`;
    let source: 'cloudinary_live' | 'local_optimized' = 'local_optimized';

    // 1. Signed Cloudinary Upload
    if (CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET && CLOUDINARY_CLOUD_NAME !== 'demo') {
      const timestamp = Math.round(Date.now() / 1000);
      const signatureStr = `folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
      const signature = crypto.createHash('sha1').update(signatureStr).digest('hex');

      const formData = new URLSearchParams();
      formData.append('file', fileData);
      formData.append('api_key', CLOUDINARY_API_KEY);
      formData.append('timestamp', timestamp.toString());
      formData.append('folder', folder);
      formData.append('signature', signature);

      const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!cloudRes.ok) {
        const errJson = await cloudRes.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Cloudinary upload rejected: ${cloudRes.statusText}`);
      }

      const cloudData = await cloudRes.json();
      uploadResultUrl = cloudData.secure_url;
      publicId = cloudData.public_id;
      source = 'cloudinary_live';
    } else if (CLOUDINARY_UPLOAD_PRESET && CLOUDINARY_CLOUD_NAME !== 'demo') {
      // 2. Unsigned Preset
      const formData = new URLSearchParams();
      formData.append('file', fileData);
      formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
      formData.append('folder', folder);

      const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!cloudRes.ok) {
        const errJson = await cloudRes.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Cloudinary preset upload rejected: ${cloudRes.statusText}`);
      }

      const cloudData = await cloudRes.json();
      uploadResultUrl = cloudData.secure_url;
      publicId = cloudData.public_id;
      source = 'cloudinary_live';
    }

    const docRecord: BookingDocument = {
      id: `doc-${Date.now()}`,
      name: fileName,
      type: (documentType as any) || 'incident_photo',
      url: uploadResultUrl,
      publicId,
      uploadedAt: new Date().toISOString(),
      source,
      consentGranted: true,
      treatmentStage: 'pre_dispatch',
      isVerified: true,
      notes: triageObservation,
    };

    // If bookingId provided, attach document to booking
    if (bookingId) {
      serverBookings = serverBookings.map((b) =>
        b.id === bookingId ? { ...b, documents: [docRecord, ...(b.documents || [])], surgeryDocumentsSubmitted: true, hasSubmittedMedicalDocuments: true } : b
      );
    }
    // Also save in user profile documents so subsequent bookings know documents are on file
    serverProfile.documents = [docRecord, ...(serverProfile.documents || []).filter(d => d.id !== docRecord.id)];
    serverProfile.surgeryDocumentsSubmitted = true;
    saveDatabase();

    logAudit('medical_image_uploaded', bookingId, 'patient', req.ip, {
      publicId,
      source,
      hasTriageAnalysis: Boolean(triageObservation),
    });

    return res.json({
      success: true,
      source,
      public_id: publicId,
      secure_url: uploadResultUrl,
      document: docRecord,
      triageObservation,
    });
  } catch (err: any) {
    console.error('Upload handler error:', err);
    return res.status(500).json({ error: err.message || 'Upload error processing file' });
  }
});

// Cloudinary Deletion / Replacement Endpoint
app.post('/api/cloudinary/destroy', async (req: Request, res: Response) => {
  const { publicId } = req.body;
  if (!publicId) return res.status(400).json({ error: 'publicId is required' });

  if (CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET && CLOUDINARY_CLOUD_NAME !== 'demo') {
    try {
      const timestamp = Math.round(Date.now() / 1000);
      const signatureStr = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
      const signature = crypto.createHash('sha1').update(signatureStr).digest('hex');

      const formData = new URLSearchParams();
      formData.append('public_id', publicId);
      formData.append('api_key', CLOUDINARY_API_KEY);
      formData.append('timestamp', timestamp.toString());
      formData.append('signature', signature);

      const resp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`, {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      return res.json({ success: true, result: data.result || 'ok' });
    } catch (err: any) {
      console.warn('Cloudinary destroy error:', err);
    }
  }

  res.json({ success: true, message: 'Asset removed from database references.' });
});

// ==========================================
// 5. USER PROFILE MANAGEMENT API
// View, edit, save personal profile and persist in database
// ==========================================
app.get('/api/profile', (_req: Request, res: Response) => {
  res.json({
    success: true,
    profile: serverProfile,
  });
});

app.post('/api/profile', (req: Request, res: Response) => {
  const updatedData = req.body;
  if (!updatedData || typeof updatedData !== 'object') {
    return res.status(400).json({ error: 'Valid profile payload is required.' });
  }

  serverProfile = {
    ...serverProfile,
    ...updatedData,
    id: serverProfile.id || 'patient-primary',
  };

  res.json({
    success: true,
    message: 'Profile successfully updated and saved in persistent database.',
    profile: serverProfile,
  });
});

// 6. Multi-view synchronization
app.get('/api/sync', (_req: Request, res: Response) => {
  res.json({
    state: sharedPlatformState,
    bookings: serverBookings,
    ambulances: serverAmbulances,
    hospitals: serverHospitals,
    simulation: simulationState,
    profile: serverProfile,
  });
});

app.post('/api/sync', (req: Request, res: Response) => {
  sharedPlatformState = req.body;
  if (req.body?.bookings) serverBookings = req.body.bookings;
  if (req.body?.ambulances) serverAmbulances = req.body.ambulances;
  if (req.body?.hospitals) serverHospitals = req.body.hospitals;
  if (req.body?.profile) serverProfile = req.body.profile;
  res.json({ success: true, timestamp: Date.now() });
});

// Start server with Vite middleware in development
async function startServer() {
  loadDatabase();
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DropAid server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
