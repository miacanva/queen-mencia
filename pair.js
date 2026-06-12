const { makeid } = require('./gen-id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const router = express.Router();

router.get('/', async (req, res) => {
    const phoneNumber = req.query.number?.replace(/\D/g, '');
    
    if (!phoneNumber || phoneNumber.length < 10) {
        return res.json({ error: "Valid number required" });
    }

    const formattedNumber = phoneNumber.startsWith('255') ? phoneNumber : `255${phoneNumber}`;
    const tempDir = path.join(__dirname, 'temp', makeid());
    
    // Ensure temp exists
    if (!fs.existsSync(path.join(__dirname, 'temp'))) {
        fs.mkdirSync(path.join(__dirname, 'temp'));
    }
    fs.mkdirSync(tempDir, { recursive: true });

    let done = false;

    // Timeout after 30 seconds
    setTimeout(() => {
        if (!done) {
            done = true;
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            res.json({ error: "Timeout. Try again." });
        }
    }, 30000);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, console)
            },
            printQRInTerminal: false,
            browser: Browsers.windows("Firefox"),
            connectTimeoutMs: 20000,
            keepAliveIntervalMs: 10000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection }) => {
            if (connection === 'open' && !done) {
                try {
                    const code = await sock.requestPairingCode(formattedNumber);
                    if (!done) {
                        done = true;
                        res.json({ code: code });
                        setTimeout(() => {
                            sock.ws?.close();
                            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
                        }, 2000);
                    }
                } catch (err) {
                    if (!done) {
                        done = true;
                        res.json({ error: err.message });
                        sock.ws?.close();
                        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                }
            }
        });

    } catch (err) {
        if (!done) {
            done = true;
            res.json({ error: err.message });
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

module.exports = router;
