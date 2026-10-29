import React, { useState, useEffect } from 'react';
import {
  Booking,
  Hospital,
  PatientProfile,
  LatLng,
  AmbulanceUnit,
  BookingDocument,
  EmergencyCategory,
  HospitalDoctor,
} from '../../types/index.ts';
import { HOSPITALS } from '../../data/mockData.ts';
import {
  Shield,
  ShieldCheck,
  User,
  Mail,
  Phone,
  FileText,
  UploadCloud,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  LogOut,
  Plus,
  Clock,
  Heart,
  Activity,
  AlertCircle,
  Building2,
  FileCheck,
  Trash2,
  ExternalLink,
  ChevronRight,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

export interface UserSession {
  username: string;
  email: string;
  phone: string;
  hasSubmittedMedicalDetails: boolean;
  loggedInAt: string;
}

interface UserDashboardProps {
  currentPickup: { coords: LatLng; address: string };
  currentDropoff: { coords: LatLng; address: string; hospitalId?: string };
  onPickupChange: (coords: LatLng, address: string) => void;
  onDropoffChange: (coords: LatLng, address: string, hospitalId?: string) => void;
  onDetectGPS: () => void;
  isDetectingGPS: boolean;
  gpsAccuracy: number;
  gpsError?: string | null;
  activeBooking: Booking | null;
  assignedAmbulance: AmbulanceUnit | null;
  bookingHistory: Booking[];
  onSubmitBooking: (intakeOrEquipment: any, notes?: string, bookingType?: 'emergency_hold' | 'manual') => void;
  onCancelActiveBooking: (id: string) => void;
  patientProfile: PatientProfile;
  onOpenUploadModal: (category: 'id_card' | 'insurance' | 'medical_history' | 'incident_photo') => void;
  ambulances: AmbulanceUnit[];
  routePolyline: [number, number][];
  routeError?: string | null;
  onRecalculateRoute?: () => void;
  isSubmitting?: boolean;
  onRetryDispatch?: (bookingId: string) => void;
  dispatchCountdown?: number | null;
  hospitals?: Hospital[];
  selectedCategory?: EmergencyCategory;
  onSelectCategory?: (category: EmergencyCategory) => void;
  onSendPreArrivalAlert?: () => Promise<void> | void;
  onUploadDocument?: (file: File, stage: 'pre_dispatch' | 'in_transit' | 'hospital_handoff' | 'post_treatment', type: 'id_card' | 'insurance' | 'medical_history' | 'prescription' | 'incident_photo') => Promise<void> | void;
  onDeleteDocument?: (docId: string) => Promise<void> | void;
  onConfirmDoctor?: (doctor: HospitalDoctor) => Promise<void> | void;
  onHospitalHandover?: (bookingId: string, details?: any) => Promise<void> | void;
  onSaveProfile?: (updated: PatientProfile) => Promise<void>;
}

export const UserDashboard: React.FC<UserDashboardProps> = ({
  currentPickup,
  currentDropoff,
  onDropoffChange,
  activeBooking,
  assignedAmbulance,
  bookingHistory,
  onSubmitBooking,
  onCancelActiveBooking,
  patientProfile,
  onOpenUploadModal,
  isSubmitting = false,
  hospitals = HOSPITALS,
  selectedCategory = 'general',
  onSelectCategory,
  onDeleteDocument,
  onSaveProfile,
}) => {
  // ------------------------------------------
  // AUTHENTICATION & ONBOARDING STATE
  // ------------------------------------------
  const [authSession, setAuthSession] = useState<UserSession | null>(() => {
    try {
      const stored = localStorage.getItem('dropaid_user_session');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {
      // fallback to initial
    }
    return null;
  });

  // Onboarding Step: 1 = Login Portal (Username, Email, Phone), 2 = Medical Details (with Skip option)
  const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1);

  // Login Form Inputs (Strictly: Username, Email, Phone)
  const [loginUsername, setLoginUsername] = useState(patientProfile.name || '');
  const [loginEmail, setLoginEmail] = useState(patientProfile.email || '');
  const [loginPhone, setLoginPhone] = useState(patientProfile.phone || '');
  const [loginError, setLoginError] = useState<string | null>(null);

  // Medical Details Intake Inputs (Can be submitted or skipped for later add-on)
  const [medBloodGroup, setMedBloodGroup] = useState(patientProfile.bloodType || 'B+');
  const [medAllergies, setMedAllergies] = useState(patientProfile.allergies?.join(', ') || 'Penicillin');
  const [medConditions, setMedConditions] = useState(patientProfile.medicalConditions?.join(', ') || 'None');
  const [medEmergencyContactName, setMedEmergencyContactName] = useState(patientProfile.emergencyContact?.name || '');
  const [medEmergencyContactPhone, setMedEmergencyContactPhone] = useState(patientProfile.emergencyContact?.phone || '');

  // Add-on Medical Details expansion toggle (for users who skipped during login)
  const [isEditingMedicalDetails, setIsEditingMedicalDetails] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'documents' | 'booking' | 'history'>('overview');

  // Emergency Booking Form State
  const [bookingFor, setBookingFor] = useState<'self' | 'someone_else'>('self');
  const [otherPatientName, setOtherPatientName] = useState('');
  const [otherPatientRelationship, setOtherPatientRelationship] = useState('Family');
  const [emergencyNotes, setEmergencyNotes] = useState('Immediate emergency evaluation and admission needed.');
  const [selectedHospitalId, setSelectedHospitalId] = useState(currentDropoff.hospitalId || hospitals[0]?.id || '');
  const [bookingFeedback, setBookingFeedback] = useState<string | null>(null);

  // Cloudinary Status Query
  const [cloudinaryConfig, setCloudinaryConfig] = useState<{ isConfigured: boolean; cloudName: string; mode: string } | null>(null);
  useEffect(() => {
    fetch('/api/cloudinary/config')
      .then((r) => r.json())
      .then((data) => setCloudinaryConfig(data))
      .catch(() => setCloudinaryConfig(null));
  }, []);

  // Sync profile when auth session exists
  useEffect(() => {
    if (authSession) {
      localStorage.setItem('dropaid_user_session', JSON.stringify(authSession));
    }
  }, [authSession]);

  // Handle Step 1: Login Submission
  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);

    const trimmedUser = loginUsername.trim();
    const trimmedEmail = loginEmail.trim();
    const trimmedPhone = loginPhone.trim();

    if (!trimmedUser) {
      setLoginError('Please enter your username.');
      return;
    }
    if (!trimmedEmail || !trimmedEmail.includes('@') || !trimmedEmail.includes('.')) {
      setLoginError('Please enter a valid email address.');
      return;
    }
    if (!trimmedPhone || trimmedPhone.length < 8) {
      setLoginError('Please enter a valid phone number with country code (e.g., +91 98765 43210).');
      return;
    }

    // Move to Step 2: Medical details intake
    setOnboardingStep(2);
  };

  // Handle Step 2: Skip for later add-on
  const handleSkipMedicalDetails = () => {
    const newSession: UserSession = {
      username: loginUsername.trim(),
      email: loginEmail.trim(),
      phone: loginPhone.trim(),
      hasSubmittedMedicalDetails: false,
      loggedInAt: new Date().toISOString(),
    };

    setAuthSession(newSession);

    // Update patient profile object
    const updatedProfile: PatientProfile = {
      ...patientProfile,
      name: newSession.username,
      email: newSession.email,
      phone: newSession.phone,
    };

    if (onSaveProfile) {
      onSaveProfile(updatedProfile);
    }
  };

  // Handle Step 2: Complete and Submit Medical Details
  const handleSaveMedicalDetails = async () => {
    const newSession: UserSession = {
      username: loginUsername.trim(),
      email: loginEmail.trim(),
      phone: loginPhone.trim(),
      hasSubmittedMedicalDetails: true,
      loggedInAt: new Date().toISOString(),
    };

    setAuthSession(newSession);

    const updatedProfile: PatientProfile = {
      ...patientProfile,
      name: newSession.username,
      email: newSession.email,
      phone: newSession.phone,
      bloodType: medBloodGroup,
      allergies: medAllergies.split(',').map((s) => s.trim()).filter(Boolean),
      medicalConditions: medConditions.split(',').map((s) => s.trim()).filter(Boolean),
      emergencyContact: {
        name: medEmergencyContactName || 'Emergency Kin',
        relationship: 'Primary Contact',
        phone: medEmergencyContactPhone || newSession.phone,
      },
    };

    if (onSaveProfile) {
      await onSaveProfile(updatedProfile);
    } else {
      localStorage.setItem('dropaid_patient_profile', JSON.stringify(updatedProfile));
    }

    setIsEditingMedicalDetails(false);
  };

  // Handle Later Add-on of Medical Details from Dashboard
  const handleLaterAddonSave = async () => {
    if (!authSession) return;

    const updatedSession: UserSession = {
      ...authSession,
      hasSubmittedMedicalDetails: true,
    };
    setAuthSession(updatedSession);

    const updatedProfile: PatientProfile = {
      ...patientProfile,
      name: authSession.username,
      email: authSession.email,
      phone: authSession.phone,
      bloodType: medBloodGroup,
      allergies: medAllergies.split(',').map((s) => s.trim()).filter(Boolean),
      medicalConditions: medConditions.split(',').map((s) => s.trim()).filter(Boolean),
      emergencyContact: {
        name: medEmergencyContactName || 'Emergency Kin',
        relationship: 'Primary Contact',
        phone: medEmergencyContactPhone || authSession.phone,
      },
    };

    if (onSaveProfile) {
      await onSaveProfile(updatedProfile);
    } else {
      localStorage.setItem('dropaid_patient_profile', JSON.stringify(updatedProfile));
    }

    setIsEditingMedicalDetails(false);
  };

  // Handle Log Out
  const handleLogOut = () => {
    localStorage.removeItem('dropaid_user_session');
    setAuthSession(null);
    setOnboardingStep(1);
  };

  // User documents from profile
  const userDocuments = patientProfile.documents || [];
  const hasDocumentsOnFile = userDocuments.length > 0 || Boolean(patientProfile.surgeryDocumentsSubmitted);

  // Handle Emergency Booking Dispatch
  const handleTriggerBooking = () => {
    setBookingFeedback(null);

    const matchedHospital = hospitals.find((h) => h.id === selectedHospitalId) || hospitals[0];
    if (matchedHospital) {
      onDropoffChange(
        { lat: matchedHospital.lat, lng: matchedHospital.lng },
        `${matchedHospital.name}, ${matchedHospital.address}`,
        matchedHospital.id
      );
    }

    const payload = {
      bookingFor,
      callerName: authSession?.username || patientProfile.name,
      callerPhone: authSession?.phone || patientProfile.phone,
      callerEmail: authSession?.email || patientProfile.email,
      patientName: bookingFor === 'someone_else' ? otherPatientName || 'Emergency Patient' : authSession?.username || patientProfile.name,
      patientPhone: bookingFor === 'someone_else' ? authSession?.phone || patientProfile.phone : authSession?.phone || patientProfile.phone,
      patientRelationship: bookingFor === 'someone_else' ? otherPatientRelationship : 'Self',
      bloodGroup: patientProfile.bloodType || medBloodGroup || 'B+',
      issueCategory: selectedCategory,
      patientNotes: emergencyNotes,
      selectedHospitalId,
      // Surgery documents flag: if documents already on file, backend clears surgery automatically
      hasSubmittedMedicalDocuments: hasDocumentsOnFile,
      surgeryDocumentsSubmitted: hasDocumentsOnFile,
    };

    onSubmitBooking(payload, emergencyNotes, 'manual');
    setBookingFeedback('Emergency request placed. Dispatching nearest ambulance and coordinating hospital ER.');
  };

  // =========================================================================
  // VIEW 1: FIRST-TIME LOAD LOGIN PORTAL
  // =========================================================================
  if (!authSession) {
    return (
      <div className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-slate-50 via-sky-50/30 to-slate-100 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-xl">
          {onboardingStep === 1 ? (
            /* STEP 1: USER LOGIN PORTAL (Username, Email ID, Phone Number) */
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200/80 overflow-hidden">
              {/* Header */}
              <div className="bg-gradient-to-r from-sky-600 via-sky-700 to-indigo-800 p-6 sm:p-8 text-white">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/15 backdrop-blur-xs text-xs font-semibold mb-3">
                  <ShieldCheck className="w-4 h-4 text-sky-200" />
                  <span>DropAid Patient Access Portal</span>
                </div>
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                  Welcome to DropAid
                </h1>
                <p className="mt-2 text-xs sm:text-sm text-sky-100 leading-relaxed">
                  Enter your user credentials to access hospital emergency coordination, medical document records, and automated surgical clearance.
                </p>
              </div>

              {/* Form */}
              <form onSubmit={handleLoginSubmit} className="p-6 sm:p-8 space-y-5">
                {loginError && (
                  <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                    <span>{loginError}</span>
                  </div>
                )}

                {/* 1. Username */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Username / Full Name <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <User className="w-4 h-4" />
                    </div>
                    <input
                      type="text"
                      required
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      placeholder="e.g. Aarav Malhotra"
                      className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 transition-all outline-hidden"
                    />
                  </div>
                </div>

                {/* 2. Email ID */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Email ID <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Mail className="w-4 h-4" />
                    </div>
                    <input
                      type="email"
                      required
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      placeholder="e.g. aarav.malhotra@gmail.com"
                      className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 transition-all outline-hidden"
                    />
                  </div>
                </div>

                {/* 3. Phone Number */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Phone Number <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                      <Phone className="w-4 h-4" />
                    </div>
                    <input
                      type="tel"
                      required
                      value={loginPhone}
                      onChange={(e) => setLoginPhone(e.target.value)}
                      placeholder="e.g. +91 98765 43210"
                      className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 transition-all outline-hidden"
                    />
                  </div>
                </div>

                {/* Submit button */}
                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full py-3 px-5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-bold text-sm shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <span>Continue to Medical Profile</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>

                <div className="text-center pt-2">
                  <span className="text-xs text-slate-500">
                    DropAid securely encrypts your credentials and coordinates with verified regional hospital trauma networks.
                  </span>
                </div>
              </form>
            </div>
          ) : (
            /* STEP 2: MEDICAL DETAILS INTAKE (With "Skip for later add-on" option) */
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200/80 overflow-hidden">
              {/* Header */}
              <div className="bg-gradient-to-r from-sky-700 to-indigo-900 p-6 sm:p-8 text-white">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/15 backdrop-blur-xs text-xs font-semibold mb-3">
                  <Heart className="w-4 h-4 text-rose-300" />
                  <span>Step 2 of 2: Medical Information</span>
                </div>
                <h2 className="text-2xl font-extrabold tracking-tight">
                  Clinical & Emergency Details
                </h2>
                <p className="mt-2 text-xs sm:text-sm text-sky-100 leading-relaxed">
                  Provide your medical history so receiving hospital trauma surgeons can prepare in advance. You can also skip this step and add it anytime later.
                </p>
              </div>

              {/* Form Body */}
              <div className="p-6 sm:p-8 space-y-5">
                {/* Blood Group */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Blood Group
                  </label>
                  <select
                    value={medBloodGroup}
                    onChange={(e) => setMedBloodGroup(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 transition-all outline-hidden cursor-pointer"
                  >
                    <option value="A+">A+ (A Positive)</option>
                    <option value="A-">A- (A Negative)</option>
                    <option value="B+">B+ (B Positive)</option>
                    <option value="B-">B- (B Negative)</option>
                    <option value="AB+">AB+ (AB Positive)</option>
                    <option value="AB-">AB- (AB Negative)</option>
                    <option value="O+">O+ (O Positive)</option>
                    <option value="O-">O- (O Negative)</option>
                    <option value="Unknown">Unknown / Need Emergency Crossmatch</option>
                  </select>
                </div>

                {/* Critical Allergies */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Critical Allergies / Medications
                  </label>
                  <input
                    type="text"
                    value={medAllergies}
                    onChange={(e) => setMedAllergies(e.target.value)}
                    placeholder="e.g. Penicillin, Sulfa drugs, Aspirin (or 'None')"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 transition-all outline-hidden"
                  />
                </div>

                {/* Pre-existing Conditions */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Pre-existing Conditions / Surgical History
                  </label>
                  <input
                    type="text"
                    value={medConditions}
                    onChange={(e) => setMedConditions(e.target.value)}
                    placeholder="e.g. Hypertension, Diabetes Type 2, Previous Stent (or 'None')"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 transition-all outline-hidden"
                  />
                </div>

                {/* Emergency Contact */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                      Emergency Kin Name
                    </label>
                    <input
                      type="text"
                      value={medEmergencyContactName}
                      onChange={(e) => setMedEmergencyContactName(e.target.value)}
                      placeholder="e.g. Priya Malhotra"
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 transition-all outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                      Emergency Kin Phone
                    </label>
                    <input
                      type="tel"
                      value={medEmergencyContactPhone}
                      onChange={(e) => setMedEmergencyContactPhone(e.target.value)}
                      placeholder="e.g. +91 98111 22334"
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-900 focus:bg-white focus:border-sky-500 focus:ring-2 focus:ring-sky-100 transition-all outline-hidden"
                    />
                  </div>
                </div>

                {/* Optional Document Upload via Cloudinary */}
                <div className="p-4 rounded-xl bg-sky-50/60 border border-sky-200/80">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-xs font-bold text-sky-950 flex items-center gap-1.5">
                        <UploadCloud className="w-4 h-4 text-sky-600" />
                        Optional Surgery / Medical Document Upload
                      </span>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        Upload prescriptions or surgical records to Cloudinary. You can also do this anytime later.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenUploadModal('medical_history')}
                      className="px-3 py-1.5 bg-white border border-sky-300 text-sky-700 hover:bg-sky-50 text-xs font-bold rounded-lg shadow-xs transition-colors shrink-0 cursor-pointer"
                    >
                      Upload File
                    </button>
                  </div>
                  {userDocuments.length > 0 && (
                    <div className="mt-2.5 pt-2 border-t border-sky-100 flex items-center gap-2 text-xs text-emerald-700 font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      <span>{userDocuments.length} document(s) uploaded to Cloudinary</span>
                    </div>
                  )}
                </div>

                {/* Action Buttons: Save vs Skip for Later Add-on */}
                <div className="pt-2 space-y-2.5">
                  <button
                    type="button"
                    onClick={handleSaveMedicalDetails}
                    className="w-full py-3 px-5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-bold text-sm shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Save Medical Profile & Enter Portal</span>
                  </button>

                  {/* PROMINENT "SKIP FOR LATER ADD-ON" BUTTON */}
                  <button
                    type="button"
                    onClick={handleSkipMedicalDetails}
                    className="w-full py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs border border-slate-300/80 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <span>Skip for later add-on</span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                  </button>
                </div>

                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => setOnboardingStep(1)}
                    className="text-xs text-slate-500 hover:text-slate-800 underline cursor-pointer"
                  >
                    ← Back to edit credentials
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // VIEW 2: AUTHENTICATED PATIENT PORTAL
  // =========================================================================
  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      {/* 1. Patient Profile Header Bar */}
      <section className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white font-black text-lg flex items-center justify-center shadow-sm uppercase">
              {authSession.username.slice(0, 2)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-extrabold text-slate-900 tracking-tight">
                  {authSession.username}
                </h1>
                {authSession.hasSubmittedMedicalDetails ? (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    Medical Profile Active
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 text-amber-600" />
                    Medical Details Pending (Add-on)
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 mt-0.5">
                <span className="flex items-center gap-1">
                  <Phone className="w-3 h-3 text-slate-400" />
                  {authSession.phone}
                </span>
                <span className="flex items-center gap-1">
                  <Mail className="w-3 h-3 text-slate-400" />
                  {authSession.email}
                </span>
                {cloudinaryConfig?.isConfigured && (
                  <span className="text-sky-600 font-medium">
                    Cloudinary CDN Active
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onOpenUploadModal('medical_history')}
              className="px-3.5 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <UploadCloud className="w-4 h-4" />
              <span>Upload Document</span>
            </button>
            <button
              onClick={handleLogOut}
              className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer"
              title="Log out and return to user sign-in"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Log Out</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <nav className="flex space-x-6 border-t border-slate-100 text-xs font-bold">
            <button
              onClick={() => setActiveTab('overview')}
              className={`py-3 border-b-2 transition-colors cursor-pointer ${
                activeTab === 'overview'
                  ? 'border-sky-600 text-sky-700'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Overview & Medical Profile
            </button>
            <button
              onClick={() => setActiveTab('booking')}
              className={`py-3 border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'booking'
                  ? 'border-sky-600 text-sky-700'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              <span>Emergency Dispatch</span>
              {activeBooking && (
                <span className="px-1.5 py-0.2 bg-rose-600 text-white rounded-full text-[10px]">
                  Active
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('documents')}
              className={`py-3 border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'documents'
                  ? 'border-sky-600 text-sky-700'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              <span>Cloudinary Document Vault</span>
              <span className="px-1.5 py-0.2 bg-slate-100 text-slate-700 rounded-full text-[10px]">
                {userDocuments.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`py-3 border-b-2 transition-colors cursor-pointer ${
                activeTab === 'history'
                  ? 'border-sky-600 text-sky-700'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Dispatch History ({bookingHistory.length})
            </button>
          </nav>
        </div>
      </section>

      {/* Main Content Area */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Active Emergency Alert Banner (If Booking is Active) */}
        {activeBooking && (
          <div className="bg-gradient-to-r from-rose-900 via-rose-800 to-red-900 text-white rounded-2xl p-5 shadow-lg border border-rose-700">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="animate-pulse w-2.5 h-2.5 rounded-full bg-rose-300"></span>
                  <span className="text-xs uppercase tracking-wider font-extrabold text-rose-200">
                    Active Emergency Booking In Progress
                  </span>
                  <span className="px-2 py-0.5 rounded bg-black/30 font-mono text-xs">
                    Case #{activeBooking.trackingCode}
                  </span>
                </div>
                <h3 className="text-xl font-bold mt-1">
                  Ambulance Dispatch: {activeBooking.stage.replace(/_/g, ' ').toUpperCase()}
                </h3>
                <p className="text-xs text-rose-100 mt-1">
                  Destination: <strong>{activeBooking.dropoffAddress.split(',')[0]}</strong> · ETA: ~
                  <strong>{activeBooking.etaMinutes} mins</strong> (Unit: {activeBooking.assignedUnitId || 'En route'})
                </p>
                <div className="mt-2.5 flex items-center gap-2 text-xs">
                  {hasDocumentsOnFile ? (
                    <span className="px-2.5 py-1 rounded bg-emerald-950/80 border border-emerald-500/50 text-emerald-200 font-semibold flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      Surgery Medical Documents: Verified on File & Hospital Cleared
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded bg-amber-950/80 border border-amber-500/50 text-amber-200 font-semibold flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                      Surgery Documents Pending: Hospital operations notified via Telegram
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => onCancelActiveBooking(activeBooking.id)}
                  className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white border border-white/20 rounded-xl text-xs font-bold transition-colors cursor-pointer"
                >
                  Cancel Booking
                </button>
              </div>
            </div>
          </div>
        )}

        {/* =========================================================================
            TAB 1: OVERVIEW & MEDICAL PROFILE (Includes "Later Add-on" Panel)
            ========================================================================= */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* If user skipped medical details on signup: PROMINENT LATER ADD-ON CARD */}
            {!authSession.hasSubmittedMedicalDetails && (
              <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-6 shadow-xs">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-900 text-xs font-bold">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-700" />
                      <span>Medical Details Pending (Add-on Available)</span>
                    </div>
                    <h3 className="text-base font-bold text-slate-900">
                      Complete Your Medical Profile for Automated Surgery Clearance
                    </h3>
                    <p className="text-xs text-slate-600 max-w-2xl leading-relaxed">
                      You skipped entering your medical details during initial sign-in. Adding your blood group, known allergies, and medical history allows DropAid and receiving hospital surgical teams to prepare trauma suites in advance without requiring physical paperwork during emergency dispatch.
                    </p>
                  </div>
                  <button
                    onClick={() => setIsEditingMedicalDetails(!isEditingMedicalDetails)}
                    className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors shrink-0 cursor-pointer"
                  >
                    {isEditingMedicalDetails ? 'Close Add-on Form' : 'Add Medical Details Now'}
                  </button>
                </div>

                {/* Inline Add-on Form */}
                {isEditingMedicalDetails && (
                  <div className="mt-5 pt-5 border-t border-amber-200/80 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                        Blood Group
                      </label>
                      <select
                        value={medBloodGroup}
                        onChange={(e) => setMedBloodGroup(e.target.value)}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 outline-hidden"
                      >
                        <option value="A+">A+ (A Positive)</option>
                        <option value="A-">A- (A Negative)</option>
                        <option value="B+">B+ (B Positive)</option>
                        <option value="B-">B- (B Negative)</option>
                        <option value="AB+">AB+ (AB Positive)</option>
                        <option value="AB-">AB- (AB Negative)</option>
                        <option value="O+">O+ (O Positive)</option>
                        <option value="O-">O- (O Negative)</option>
                        <option value="Unknown">Unknown (Emergency Crossmatch)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                        Critical Allergies
                      </label>
                      <input
                        type="text"
                        value={medAllergies}
                        onChange={(e) => setMedAllergies(e.target.value)}
                        placeholder="e.g. Penicillin, NSAIDs, Aspirin"
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 outline-hidden"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                        Pre-existing Medical Conditions / Surgery History
                      </label>
                      <input
                        type="text"
                        value={medConditions}
                        onChange={(e) => setMedConditions(e.target.value)}
                        placeholder="e.g. Hypertension, Cardiac Stent, Diabetes"
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 outline-hidden"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                        Emergency Kin Contact (Name & Phone)
                      </label>
                      <input
                        type="text"
                        value={medEmergencyContactName}
                        onChange={(e) => setMedEmergencyContactName(e.target.value)}
                        placeholder="e.g. Priya Malhotra (+91 98111 22334)"
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 outline-hidden"
                      />
                    </div>

                    <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => setIsEditingMedicalDetails(false)}
                        className="px-4 py-2 border border-slate-300 bg-white text-slate-700 text-xs font-semibold rounded-lg hover:bg-slate-50 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleLaterAddonSave}
                        className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg shadow-xs cursor-pointer flex items-center gap-1.5"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Save & Activate Medical Profile</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Medical Profile Summary Card */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
              <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                <div className="flex items-center gap-2.5">
                  <Heart className="w-5 h-5 text-rose-500" />
                  <h3 className="text-base font-bold text-slate-900">
                    Emergency Medical Summary Card
                  </h3>
                </div>
                {authSession.hasSubmittedMedicalDetails && (
                  <button
                    onClick={() => setIsEditingMedicalDetails(!isEditingMedicalDetails)}
                    className="text-xs text-sky-600 hover:text-sky-800 font-bold cursor-pointer"
                  >
                    {isEditingMedicalDetails ? 'Done Editing' : 'Edit Details'}
                  </button>
                )}
              </div>

              {isEditingMedicalDetails && authSession.hasSubmittedMedicalDetails ? (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                      Blood Group
                    </label>
                    <select
                      value={medBloodGroup}
                      onChange={(e) => setMedBloodGroup(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 outline-hidden"
                    >
                      <option value="A+">A+</option>
                      <option value="A-">A-</option>
                      <option value="B+">B+</option>
                      <option value="B-">B-</option>
                      <option value="AB+">AB+</option>
                      <option value="AB-">AB-</option>
                      <option value="O+">O+</option>
                      <option value="O-">O-</option>
                      <option value="Unknown">Unknown</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                      Critical Allergies
                    </label>
                    <input
                      type="text"
                      value={medAllergies}
                      onChange={(e) => setMedAllergies(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-medium text-slate-900 outline-hidden"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                      Pre-existing Conditions / Surgical History
                    </label>
                    <input
                      type="text"
                      value={medConditions}
                      onChange={(e) => setMedConditions(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-medium text-slate-900 outline-hidden"
                    />
                  </div>

                  <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={handleLaterAddonSave}
                      className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold rounded-lg shadow-xs cursor-pointer"
                    >
                      Update Profile
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-5">
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                      Blood Group
                    </span>
                    <span className="text-xl font-black text-slate-900 mt-1 block">
                      {patientProfile.bloodType || medBloodGroup || 'Pending'}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                      Known Allergies
                    </span>
                    <span className="text-xs font-bold text-slate-900 mt-1 block truncate">
                      {patientProfile.allergies?.join(', ') || medAllergies || 'None Recorded'}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                      Medical Conditions
                    </span>
                    <span className="text-xs font-bold text-slate-900 mt-1 block truncate">
                      {patientProfile.medicalConditions?.join(', ') || medConditions || 'None Recorded'}
                    </span>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                      Emergency Kin
                    </span>
                    <span className="text-xs font-bold text-slate-900 mt-1 block truncate">
                      {patientProfile.emergencyContact?.name || medEmergencyContactName || 'Family'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Cloudinary Documents Status Banner */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <FileCheck className="w-5 h-5 text-sky-600" />
                  <h3 className="text-base font-bold text-slate-900">
                    Surgery Documents & Hospital Clearance Status
                  </h3>
                </div>
                {hasDocumentsOnFile ? (
                  <p className="text-xs text-emerald-700 font-semibold flex items-center gap-1.5 mt-1">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>
                      Medical & surgery documents on file ({userDocuments.length} record/s). DropAid handles hospital surgical clearance automatically with zero paperwork needed during dispatch.
                    </span>
                  </p>
                ) : (
                  <p className="text-xs text-amber-700 font-semibold flex items-center gap-1.5 mt-1">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>
                      No surgery documents submitted yet. If an emergency occurs, hospital operations will be notified via Telegram to request emergency files.
                    </span>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => onOpenUploadModal('medical_history')}
                  className="px-4 py-2 bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 text-xs font-bold rounded-xl transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <UploadCloud className="w-4 h-4" />
                  <span>Upload Surgery Document</span>
                </button>
                <button
                  onClick={() => setActiveTab('documents')}
                  className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-colors cursor-pointer"
                >
                  View Vault ➔
                </button>
              </div>
            </div>

            {/* Quick Emergency Dispatch Action Card */}
            <div className="bg-gradient-to-r from-sky-900 via-indigo-950 to-slate-900 text-white rounded-2xl p-6 shadow-md flex flex-col md:flex-row md:items-center md:justify-between gap-6">
              <div className="space-y-1">
                <span className="text-xs font-bold uppercase tracking-wider text-sky-300">
                  Instant Emergency Care
                </span>
                <h3 className="text-xl font-extrabold tracking-tight">
                  Need an Ambulance or ER Admission?
                </h3>
                <p className="text-xs text-slate-300 max-w-xl">
                  DropAid dispatches nearest verified ambulances, transmits medical history to trauma bays, and monitors road transit in the backend.
                </p>
              </div>
              <button
                onClick={() => setActiveTab('booking')}
                className="px-6 py-3 bg-rose-600 hover:bg-rose-700 text-white text-sm font-extrabold rounded-xl shadow-lg hover:shadow-xl transition-all shrink-0 cursor-pointer flex items-center gap-2"
              >
                <Activity className="w-4 h-4" />
                <span>Go to Emergency Dispatch</span>
              </button>
            </div>
          </div>
        )}

        {/* =========================================================================
            TAB 2: CLOUDINARY SURGERY & MEDICAL DOCUMENT VAULT
            ========================================================================= */}
        {activeTab === 'documents' && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-slate-100">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-sky-600" />
                    <h2 className="text-lg font-bold text-slate-900">
                      Digital Medical Records & Surgery Documents Vault
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Powered by Cloudinary signed medical uploads. Verified documents are automatically forwarded to hospital surgery bays upon dispatch.
                  </p>
                </div>
                <button
                  onClick={() => onOpenUploadModal('medical_history')}
                  className="px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors flex items-center gap-2 shrink-0 cursor-pointer"
                >
                  <UploadCloud className="w-4 h-4" />
                  <span>Upload New Document</span>
                </button>
              </div>

              {/* Status Indicator */}
              <div className="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <strong>Cloudinary Delivery Status:</strong>{' '}
                    {cloudinaryConfig?.isConfigured
                      ? `Active Signed CDN (${cloudinaryConfig.cloudName})`
                      : 'Local High-Security Encrypted Storage (Ready for Cloudinary Credentials)'}
                  </div>
                  <span className="text-[11px] font-mono uppercase bg-white border border-slate-200 px-2 py-0.5 rounded text-slate-700 font-bold self-start">
                    {cloudinaryConfig?.mode || 'local_optimized'}
                  </span>
                </div>
              </div>

              {/* Documents List */}
              {userDocuments.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-xl mt-6">
                  <FileText className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <h4 className="text-sm font-bold text-slate-800">No medical documents uploaded yet</h4>
                  <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                    Upload health insurance, government photo ID, prescriptions, or prior surgical clearances to avoid delays at the hospital.
                  </p>
                  <button
                    onClick={() => onOpenUploadModal('medical_history')}
                    className="mt-4 px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold rounded-lg cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <UploadCloud className="w-3.5 h-3.5" />
                    <span>Upload First Document</span>
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
                  {userDocuments.map((doc) => (
                    <div
                      key={doc.id}
                      className="p-4 rounded-xl border border-slate-200 bg-white hover:border-sky-300 transition-all shadow-xs flex flex-col justify-between"
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase bg-sky-50 text-sky-800 border border-sky-200">
                            {doc.type.replace(/_/g, ' ')}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {new Date(doc.uploadedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <h4 className="text-xs font-bold text-slate-900 truncate" title={doc.name}>
                          {doc.name}
                        </h4>
                        {doc.notes && (
                          <p className="text-[11px] text-slate-600 bg-slate-50 p-2 rounded border border-slate-100">
                            {doc.notes}
                          </p>
                        )}
                      </div>

                      <div className="pt-3 mt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                        <a
                          href={doc.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sky-600 hover:text-sky-800 font-bold inline-flex items-center gap-1"
                        >
                          <span>View Document</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                        {onDeleteDocument && (
                          <button
                            onClick={() => onDeleteDocument(doc.id)}
                            className="text-rose-600 hover:text-rose-800 p-1 rounded hover:bg-rose-50 cursor-pointer"
                            title="Delete document"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* =========================================================================
            TAB 3: EMERGENCY DISPATCH & HOSPITAL ADMISSION (Clean, Backend-Handled)
            ========================================================================= */}
        {activeTab === 'booking' && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-xs">
              <div className="pb-5 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Activity className="w-5 h-5 text-rose-600" />
                  <h2 className="text-xl font-bold text-slate-900">
                    Emergency Hospital Admission & Ambulance Dispatch
                  </h2>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Ambulance proximity matching, live routing, and hospital trauma team alerts are coordinated in the backend.
                </p>
              </div>

              {bookingFeedback && (
                <div className="mt-4 p-3.5 rounded-xl bg-sky-50 border border-sky-200 text-sky-800 text-xs font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-sky-600 shrink-0" />
                  <span>{bookingFeedback}</span>
                </div>
              )}

              <div className="mt-6 space-y-6">
                {/* 1. Who is this booking for? */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                    Who requires emergency admission?
                  </label>
                  <div className="grid grid-cols-2 gap-3 max-w-md">
                    <button
                      type="button"
                      onClick={() => setBookingFor('self')}
                      className={`p-3 rounded-xl border text-xs font-bold transition-all cursor-pointer text-left ${
                        bookingFor === 'self'
                          ? 'border-sky-600 bg-sky-50 text-sky-900 shadow-xs'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <User className="w-4 h-4 text-sky-600 mb-1" />
                      <div>Myself ({authSession.username})</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setBookingFor('someone_else')}
                      className={`p-3 rounded-xl border text-xs font-bold transition-all cursor-pointer text-left ${
                        bookingFor === 'someone_else'
                          ? 'border-sky-600 bg-sky-50 text-sky-900 shadow-xs'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <User className="w-4 h-4 text-sky-600 mb-1" />
                      <div>Someone Else (Family/Other)</div>
                    </button>
                  </div>
                </div>

                {/* Patient details if someone else */}
                {bookingFor === 'someone_else' && (
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                        Patient Full Name
                      </label>
                      <input
                        type="text"
                        value={otherPatientName}
                        onChange={(e) => setOtherPatientName(e.target.value)}
                        placeholder="e.g. Ramesh Kumar"
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 outline-hidden"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                        Relationship to Caller
                      </label>
                      <input
                        type="text"
                        value={otherPatientRelationship}
                        onChange={(e) => setOtherPatientRelationship(e.target.value)}
                        placeholder="e.g. Parent, Child, Spouse, Colleague"
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 outline-hidden"
                      />
                    </div>
                  </div>
                )}

                {/* 2. Emergency Specialty */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                    Emergency Nature / Category
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
                    {(
                      [
                        { id: 'general', label: 'General / ER' },
                        { id: 'cardiac', label: 'Cardiac / Heart' },
                        { id: 'trauma', label: 'Trauma / Accident' },
                        { id: 'pediatric', label: 'Pediatric' },
                        { id: 'stroke', label: 'Stroke / Neuro' },
                        { id: 'burns', label: 'Burns' },
                      ] as const
                    ).map((cat) => (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => onSelectCategory && onSelectCategory(cat.id)}
                        className={`p-2.5 rounded-lg border font-semibold text-center transition-all cursor-pointer ${
                          selectedCategory === cat.id
                            ? 'border-sky-600 bg-sky-50 text-sky-900 font-bold'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {cat.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 3. Destination Hospital */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Receiving Hospital ER
                  </label>
                  <select
                    value={selectedHospitalId}
                    onChange={(e) => setSelectedHospitalId(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-900 outline-hidden cursor-pointer"
                  >
                    {hospitals.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name} — {h.address} ({h.traumaLevel}, {h.availableBeds} beds available)
                      </option>
                    ))}
                  </select>
                </div>

                {/* 4. Symptoms / Notes */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    Patient Symptoms / Incident Notes
                  </label>
                  <textarea
                    rows={2}
                    value={emergencyNotes}
                    onChange={(e) => setEmergencyNotes(e.target.value)}
                    placeholder="Describe main symptoms, breathing state, or accident details..."
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-medium text-slate-900 outline-hidden"
                  />
                </div>

                {/* Surgery Document Status Callout */}
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-800">
                      Hospital Surgery Clearance Automation:
                    </span>
                    {hasDocumentsOnFile ? (
                      <span className="text-emerald-700 font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        Documents Ready · Immediate Surgical Prep
                      </span>
                    ) : (
                      <span className="text-amber-700 font-bold flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                        No Documents · Link Sent to Operations
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    {hasDocumentsOnFile
                      ? 'Because your medical documents are already uploaded, you will not be asked to fill paperwork. DropAid will automatically manage hospital and surgical bay intake.'
                      : 'You have not uploaded surgery documents yet. An access-controlled link will be dispatched via Telegram to complete surgical clearance during ambulance transit.'}
                  </p>
                </div>

                {/* Dispatch Button */}
                <div>
                  <button
                    type="button"
                    onClick={handleTriggerBooking}
                    disabled={isSubmitting}
                    className="w-full py-3.5 px-6 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-sm shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:bg-slate-400"
                  >
                    {isSubmitting ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Dispatching Ambulance & Coordinating ER...</span>
                      </>
                    ) : (
                      <>
                        <Activity className="w-4 h-4" />
                        <span>Confirm Emergency Ambulance & Hospital Dispatch</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* =========================================================================
            TAB 4: DISPATCH HISTORY
            ========================================================================= */}
        {activeTab === 'history' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
            <h3 className="text-base font-bold text-slate-900 mb-4">
              Emergency Transfer History
            </h3>

            {bookingHistory.length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-xs font-medium">
                No past emergency bookings found on record.
              </div>
            ) : (
              <div className="space-y-3">
                {bookingHistory.map((item) => (
                  <div
                    key={item.id}
                    className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-slate-900">
                          #{item.trackingCode}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                            item.stage === 'completed'
                              ? 'bg-emerald-100 text-emerald-800'
                              : item.stage === 'cancelled'
                              ? 'bg-slate-200 text-slate-700'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {item.stage.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="text-slate-600">
                        Destination: <strong>{item.dropoffAddress.split(',')[0]}</strong>
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Patient: {item.patientName} · {new Date(item.createdAt).toLocaleString()}
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="text-[11px] font-semibold text-slate-500 block">
                        Assigned Unit: {item.assignedUnitId || 'Direct ER Transfer'}
                      </span>
                      <span className="text-[11px] text-emerald-700 font-bold block">
                        {item.surgeryDocumentsSubmitted ? 'Surgery Cleared' : 'Standard Intake'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};
