/**
 * MURIDKU MASTER — Firebase Cloud Functions
 * Deploy: firebase deploy --only functions
 * 
 * Functions:
 *   - masterAction  : block / unblock / delete user (Auth + Firestore data)
 *   - getStorageStats : kira saiz & bilangan gambar dalam Firebase Storage
 *   - getAuthUsers   : senarai semua Auth users dengan metadata
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

initializeApp();

// ── HELPER: Sahkan caller adalah Super Admin ──────────────────────────────────
const SUPER_ADMIN_UID = "PXvV4DSaI2QJ2AoE3DhWBcgMZNU2"; // <-- tukar ke UID awak

function assertSuperAdmin(auth) {
    if (!auth || !auth.uid) throw new HttpsError("unauthenticated", "Login diperlukan.");
    if (auth.uid !== SUPER_ADMIN_UID) throw new HttpsError("permission-denied", "Akses ditolak.");
}

// ── FUNCTION 1: masterAction ─────────────────────────────────────────────────
// action: "block" | "unblock" | "delete"
// targetUid: UID pengguna yang ingin dikenakan tindakan
exports.masterAction = onCall({ region: "asia-southeast1" }, async (request) => {
    assertSuperAdmin(request.auth);

    const { action, targetUid } = request.data;
    if (!action || !targetUid) throw new HttpsError("invalid-argument", "action dan targetUid diperlukan.");
    if (targetUid === SUPER_ADMIN_UID) throw new HttpsError("permission-denied", "Tidak boleh kenakan tindakan ke atas Super Admin sendiri.");

    const authAdmin = getAuth();
    const db = getFirestore();

    if (action === "block") {
        await authAdmin.updateUser(targetUid, { disabled: true });
        return { success: true, message: `Pengguna ${targetUid} telah diblok.` };
    }

    if (action === "unblock") {
        await authAdmin.updateUser(targetUid, { disabled: false });
        return { success: true, message: `Pengguna ${targetUid} telah dibuka blok.` };
    }

    if (action === "delete") {
        // 1. Padam semua rekod murid dalam Firestore
        const muridQuery = await db.collection("murid").where("userId", "==", targetUid).get();
        const batch = db.batch();
        muridQuery.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();

        // 2. Padam akaun Auth
        await authAdmin.deleteUser(targetUid);

        return {
            success: true,
            message: `Pengguna ${targetUid} + ${muridQuery.size} rekod murid telah dipadam.`,
            deletedMurid: muridQuery.size
        };
    }

    if (action === "getStatus") {
        try {
            const userRecord = await authAdmin.getUser(targetUid);
            return {
                success: true,
                uid: userRecord.uid,
                email: userRecord.email,
                displayName: userRecord.displayName,
                disabled: userRecord.disabled,
                creationTime: userRecord.metadata.creationTime,
                lastSignInTime: userRecord.metadata.lastSignInTime,
                photoURL: userRecord.photoURL,
            };
        } catch (e) {
            return { success: false, message: "Pengguna tidak dijumpai dalam Auth." };
        }
    }

    throw new HttpsError("invalid-argument", `Tindakan tidak dikenali: ${action}`);
});

// ── FUNCTION 2: getAuthUsers ──────────────────────────────────────────────────
// Kembalikan senarai semua Auth users dengan metadata (email, displayName, disabled, lastLogin)
exports.getAuthUsers = onCall({ region: "asia-southeast1" }, async (request) => {
    assertSuperAdmin(request.auth);

    const authAdmin = getAuth();
    const users = [];
    let pageToken = undefined;

    // Firebase Auth boleh ada banyak user — kita list page by page (max 1000 setiap page)
    do {
        const result = await authAdmin.listUsers(1000, pageToken);
        result.users.forEach(u => {
            users.push({
                uid: u.uid,
                email: u.email || null,
                displayName: u.displayName || null,
                photoURL: u.photoURL || null,
                disabled: u.disabled,
                creationTime: u.metadata.creationTime,
                lastSignInTime: u.metadata.lastSignInTime,
                emailVerified: u.emailVerified,
                providerData: u.providerData.map(p => p.providerId),
            });
        });
        pageToken = result.pageToken;
    } while (pageToken);

    return { success: true, users, total: users.length };
});

// ── FUNCTION 3: getStorageStats ───────────────────────────────────────────────
// Kira saiz total dan bilangan fail dalam Firebase Storage bucket
exports.getStorageStats = onCall({ region: "asia-southeast1" }, async (request) => {
    assertSuperAdmin(request.auth);

    const bucket = getStorage().bucket();

    let totalSize = 0;
    let totalFiles = 0;
    let imageCount = 0;
    const folderMap = {}; // { userId: { count, size } }

    // List semua fail dalam bucket (dengan pagination)
    let pageToken = undefined;
    do {
        const [files, , meta] = await bucket.getFiles({
            maxResults: 1000,
            pageToken,
        });

        files.forEach(file => {
            const size = parseInt(file.metadata.size || 0, 10);
            totalSize += size;
            totalFiles++;

            // Detect images
            const ct = file.metadata.contentType || '';
            if (ct.startsWith('image/')) imageCount++;

            // Extract userId from path (murid/{userId}/{filename})
            const parts = file.name.split('/');
            if (parts.length >= 2) {
                const uid = parts[1];
                if (!folderMap[uid]) folderMap[uid] = { count: 0, size: 0 };
                folderMap[uid].count++;
                folderMap[uid].size += size;
            }
        });

        pageToken = meta?.pageToken;
    } while (pageToken);

    // Firebase Storage free tier: 5 GB storage, 1 GB/day download
    const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
    const usagePct = (totalSize / FREE_QUOTA_BYTES * 100).toFixed(2);

    // Top 10 users by storage
    const topUsers = Object.entries(folderMap)
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, 10)
        .map(([uid, data]) => ({ uid, ...data }));

    return {
        success: true,
        totalSize,
        totalFiles,
        imageCount,
        usagePct: parseFloat(usagePct),
        freeQuotaBytes: FREE_QUOTA_BYTES,
        topUsers,
        // Anggaran kos kalau exceed free tier ($0.026/GB)
        estimatedCostUSD: totalSize > FREE_QUOTA_BYTES
            ? (((totalSize - FREE_QUOTA_BYTES) / 1024 / 1024 / 1024) * 0.026).toFixed(4)
            : "0.00",
    };
});
