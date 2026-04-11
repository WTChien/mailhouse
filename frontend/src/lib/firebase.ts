import { getApp, getApps, initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};

export const FIREBASE_MISSING_KEYS = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

export const FIREBASE_ENV_READY = FIREBASE_MISSING_KEYS.length === 0;

if (!FIREBASE_ENV_READY) {
  console.warn(`Firebase env is incomplete: ${FIREBASE_MISSING_KEYS.join(', ')}`);
}

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const MAIL_DOMAIN = import.meta.env.VITE_MAIL_DOMAIN ?? 'gradaide.xyz';
