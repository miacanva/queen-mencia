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
    makeCacheableSignalKeyStore,
    DisconnectReason
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
    
    // Ensure phone number has country code
    const formattedNumber = phoneNumber.startsWith('255') ? phoneNumber : `255${phoneNumber}`;

    if (!phoneNumber || phoneNumber.length < 10) {
        return res.status(400).send({ error: "Please provide a valid phone number with country code" });
    }

    console.log(`📱 Starting pairing for: ${formattedNumber}`);

    // Set timeout for the entire operation (60 seconds)
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            removeFolder(tempDir);
            res.status(504).send({ error: "Request timeout. Please try again." });
        }
    }, 90000);

    let pairingCodeSent = false;
    let sock = null;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        const logger = pino({ level: "silent" });

        sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 15000,
            emitOwnEvents: false,
            fireInitQueries: true,
            generateHighQualityLinkPreview: false,
            patchMessageBeforeSending: false
        });

        sock.ev.on('creds.update', saveCreds);

        // Handle connection updates
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            console.log(`📡 Connection state: ${connection}`);

            if (connection === "open") {
                console.log(`✅ Connection opened for ${sock.user?.id || 'unknown'}`);
                
                // Don't send session message here - just cleanup after pairing
                setTimeout(async () => {
                    try {
                        await sock.ws?.close();
                        removeFolder(tempDir);
                        clearTimeout(timeout);
                        console.log(`🧹 Cleaned up temp folder`);
                    } catch (err) {
                        console.log(`Cleanup error: ${err.message}`);
                    }
                }, 10000);

            } else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !pairingCodeSent;
                
                console.log(`🔌 Connection closed. Status: ${statusCode}, Should reconnect: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    console.log(`🔄 Reconnecting in 2 seconds...`);
                    await delay(2000);
                    if (!pairingCodeSent && !res.headersSent) {
                        // Don't recreate the whole session, just let it close
                        removeFolder(tempDir);
                    }
                } else {
                    clearTimeout(timeout);
                    removeFolder(tempDir);
                }
            }
        });

        // Request pairing code BEFORE waiting for connection
        if (!state.creds.registered) {
            console.log(`🔐 Requesting pairing code for ${formattedNumber}...`);
            
            // Small delay to let socket initialize
            await delay(2000);
            
            try {
                // Try multiple times with different approaches
                let pairingCode = null;
                let attempts = 0;
                const maxAttempts = 2;
                
                while (attempts < maxAttempts && !pairingCode) {
                    attempts++;
                    console.log(`📱 Attempt ${attempts} to get pairing code...`);
                    
                    try {
                        // The correct method - just the phone number
                        pairingCode = await sock.requestPairingCode(formattedNumber);
                        console.log(`✅ Got pairing code: ${pairingCode}`);
                        break;
                    } catch (err) {
                        console.log(`⚠️ Attempt ${attempts} failed: ${err.message}`);
                        if (err.message.includes("timeout") || err.message.includes("Closed")) {
                            await delay(3000);
                        } else {
                            break;
                        }
                    }
                }
                
                if (pairingCode && !pairingCodeSent && !res.headersSent) {
                    pairingCodeSent = true;
                    clearTimeout(timeout);
                    return res.send({ 
                        code: pairingCode,
                        message: "Use this code to pair your WhatsApp"
                    });
                } else {
                    throw new Error("Failed to get pairing code after attempts");
                }
                
            } catch (err) {
                console.error(`❌ Pairing error: ${err.message}`);
                clearTimeout(timeout);
                removeFolder(tempDir);
                
                if (!res.headersSent) {
                    return res.status(500).send({ 
                        error: err.message.includes("timeout") 
                            ? "Request timeout. Try again on a stable network."
                            : err.message.includes("Precondition")
                            ? "Server busy. Please wait 30 seconds and try again."
                            : `Error: ${err.message}`
                    });
                }
            }
        } else {
            console.log(`Already registered, skipping pairing`);
            clearTimeout(timeout);
            removeFolder(tempDir);
            if (!res.headersSent) {
                res.status(400).send({ error: "Already registered. Use different number." });
            }
        }
        
    } catch (err) {
        console.error(`🚨 Fatal: ${err.message}`);
        clearTimeout(timeout);
        removeFolder(tempDir);
        if (!res.headersSent) {
            res.status(500).send({ error: `Server error: ${err.message}` });
        }
    }
});

module.exports = router;
