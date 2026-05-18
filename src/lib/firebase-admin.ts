import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let app: App;

function getAdminApp(): App {
  if (!app) {
    if (getApps().length) {
      app = getApps()[0];
    } else {
      const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
      app = initializeApp({
        credential: cert(serviceAccount ? JSON.parse(serviceAccount) : {}),
      });
    }
  }
  return app;
}

export const adminAuth = {
  verifyIdToken: (token: string) => getAuth(getAdminApp()).verifyIdToken(token),
};
