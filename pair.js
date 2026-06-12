const { makeid } = require('./gen-id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const router = express.Router();

function removeFolder(folderPath) {
    if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
    }
}

router.get('/', async (req, res) => {
    const id = makeid();
    const tempDir = path.join(__dirname, 'temp', id);
    const phoneNumber = (req.query.number || '').replace(/\D/g, '');

    if (!phoneNumber) {
        return res.status(400).send({ error: "Please provide a valid phone number" });
    }

    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            removeFolder(tempDir);
            res.status(504).send({ error: "Request timeout. Please try again." });
        }
    }, 60000);

    async function createSocketSession() {
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        const logger = pino({ level: "fatal" }).child({ level: "fatal" });

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
            logger,
            syncFullHistory: false,
            browser: Browsers.macOS("Safari"),
            // FIX: Add these options to handle preconditions
            version: [2, 3000, 1015901307], // Force specific WhatsApp version
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            fireInitQueries: true
        });

        sock.ev.on('creds.update', saveCreds);

        // FIX: Handle pairing code response properly
        let pairingCodeSent = false;

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                await delay(5000);

                try {
                    const credsPath = path.join(tempDir, 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        const sessionData = fs.readFileSync(credsPath, 'utf8');
                        const base64 = Buffer.from(sessionData).toString('base64');
                        const sessionId = "QUEEN-MENCIA~" + base64;

                        await sock.sendMessage(sock.user.id, { text: sessionId });

                        const successMsg = {
                            text: `👸*QUEEN-MENCIA Session Created!*\n\n` +
                                `▸ *Never share* your session ID\n` +
                                `▸ Join our WhatsApp Channel\n` +
                                `▸ Report bugs on GitHub\n\n` +
                                `_Powered by QUEEN-MENCIA_\n\n` +
                                `🔗 *Useful Links:*\n` +
                                `▸ GitHub: https://github.com/miacanva/Queen-mencia\n` +
                                `▸ WhatsApp Channel: https://whatsapp.com/channel/0029VbCSzViAjPXF9tcEJg37`,
                            contextInfo: {
                                mentionedJid: [sock.user.id],
                                forwardingScore: 1000,
                                isForwarded: true
                            }
                        };

                        await sock.sendMessage(sock.user.id, successMsg);
                    }
                } catch (err) {
                    console.error("❌ Session Error:", err.message);
                } finally {
                    await delay(1000);
                    await sock.ws?.close();
                    removeFolder(tempDir);
                    clearTimeout(timeout);
                    console.log(`✅ Session completed`);
                }

            } else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== 401) {
                    console.log("🔁 Reconnecting...");
                    await delay(10);
                    createSocketSession();
                } else {
                    clearTimeout(timeout);
                    removeFolder(tempDir);
                }
            }
        });

        // FIX: Handle pairing code request with retry logic
        if (!sock.authState.creds.registered) {
            await delay(2000);
            
            let retries = 0;
            const maxRetries = 3;
            
            while (retries < maxRetries && !pairingCodeSent) {
                try {
                    console.log(`📱 Requesting pairing code for ${phoneNumber} (attempt ${retries + 1})`);
                    const pairingCode = await sock.requestPairingCode(phoneNumber);
                    
                    if (pairingCode && !res.headersSent) {
                        pairingCodeSent = true;
                        clearTimeout(timeout);
                        return res.send({ code: pairingCode });
                    }
                    break;
                } catch (err) {
                    console.error(`❌ Pairing attempt ${retries + 1} failed:`, err.message);
                    
                    // Check for precondition error
                    if (err.message.includes('Precondition') || err.message.includes('428')) {
                        console.log("⚠️ Precondition Required - Retrying with delay...");
                        await delay(3000);
                        retries++;
                        
                        if (retries === maxRetries) {
                            clearTimeout(timeout);
                            if (!res.headersSent) {
                                return res.status(428).send({ 
                                    error: "Precondition Required. Please try again in a few moments.",
                                    code: "PRECONDITION_REQUIRED"
                                });
                            }
                        }
                    } else if (err.message.includes('timeout') || err.message.includes('rate')) {
                        await delay(5000);
                        retries++;
                    } else {
                        clearTimeout(timeout);
                        if (!res.headersSent) {
                            return res.status(500).send({ error: err.message });
                        }
                        break;
                    }
                }
            }
        }
    }

    try {
        await createSocketSession();
    } catch (err) {
        console.error("🚨 Fatal Error:", err.message);
        removeFolder(tempDir);
        clearTimeout(timeout);
        if (!res.headersSent) {
            res.status(500).send({ error: "Service Unavailable. Try again later." });
        }
    }
});

module.exports = router;
