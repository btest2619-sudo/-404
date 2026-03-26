const { default: makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const app = express();
const port = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "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";
const GITHUB_REPO = process.env.GITHUB_REPO || "btest2619-sudo/-404";
const SESSION_BRANCH = "session-data";

const logoUrl = 'https://files.catbox.moe/90yqxb.png';
async function uploadToGitHub(filePath, content) {
    try {
        const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
        
        let sha = null;
        try {
            const existing = await axios.get(url, {
                headers: { 
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                },
                params: { ref: SESSION_BRANCH }
            });
            sha = existing.data.sha;
        } catch (err) {
        }

        const data = {
            message: `Update ${filePath}`,
            content: Buffer.from(content).toString('base64'),
            branch: SESSION_BRANCH
        };

        if (sha) data.sha = sha;

        await axios.put(url, data, {
            headers: { 
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        console.log(`✅ Uploaded: ${filePath}`);
    } catch (err) {
        console.error(`❌ Upload failed for ${filePath}:`, err.message);
    }
}

async function downloadFromGitHub(filePath) {
    try {
        const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
        const response = await axios.get(url, {
            headers: { 
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            params: { ref: SESSION_BRANCH }
        });

        return Buffer.from(response.data.content, 'base64').toString('utf-8');
    } catch (err) {
        return null;
    }
}

async function syncSessionToGitHub() {
    const sessionPath = './session';
    if (!fs.existsSync(sessionPath)) return;

    const files = fs.readdirSync(sessionPath);
    for (const file of files) {
        const filePath = path.join(sessionPath, file);
        if (fs.statSync(filePath).isFile()) {
            const content = fs.readFileSync(filePath, 'utf-8');
            await uploadToGitHub(`session/${file}`, content);
        }
    }
    console.log("📤 Session synced to GitHub");
}

async function loadSessionFromGitHub() {
    try {
        const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/session`;
        const response = await axios.get(url, {
            headers: { 
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            params: { ref: SESSION_BRANCH }
        });

        if (!fs.existsSync('./session')) {
            fs.mkdirSync('./session', { recursive: true });
        }

        for (const file of response.data) {
            if (file.type === 'file') {
                const content = await downloadFromGitHub(`session/${file.name}`);
                if (content) {
                    fs.writeFileSync(`./session/${file.name}`, content);
                    console.log(`📥 Downloaded: ${file.name}`);
                }
            }
        }
        console.log("✅ Session loaded from GitHub");
    } catch (err) {
        console.log("ℹ️ No existing session found on GitHub");
    }
}

async function createSessionBranch() {
    try {
        const mainBranch = await axios.get(
            `https://api.github.com/repos/${GITHUB_REPO}/git/ref/heads/main`,
            { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } }
        );

        await axios.post(
            `https://api.github.com/repos/${GITHUB_REPO}/git/refs`,
            {
                ref: `refs/heads/${SESSION_BRANCH}`,
                sha: mainBranch.data.object.sha
            },
            { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } }
        );
        console.log("✅ Session branch created");
    } catch (err) {
        if (err.response?.status !== 422) {
            console.log("ℹ️ Session branch already exists");
        }
    }
}
let saveInterval;
function startAutoSync() {
    saveInterval = setInterval(async () => {
        await syncSessionToGitHub();
    }, 5 * 60 * 1000); 
}

async function startVoidBot() {
    await createSessionBranch();
    await loadSessionFromGitHub();

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();
    
    const client = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    app.use(express.static('public'));
    
    app.get('/pair', async (req, res) => {
        let num = req.query.number?.replace(/[^0-9]/g, '');
        if (!num) return res.status(400).json({ error: "Number required" });
        
        try {
            await delay(3000);
            let code = await client.requestPairingCode(num);
            res.json({ status: 'success', code: code });
        } catch (err) { 
            res.status(500).json({ error: "Pairing failed", message: err.message }); 
        }
    });

    client.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === "open") {
            console.log("✅ Bot Connected!");
            await syncSessionToGitHub();
            startAutoSync();
            
            try {
                await client.sendMessage(client.user.id, { 
                    image: { url: logoUrl }, 
                    caption: "✅ شكراً لاستخدامك تشالاه فويد ٤٠٤\n\n🔐 تم تفعيل النظام بنجاح\n📡 Session synced to GitHub\n♻️ Auto-restart enabled\n\nاستعد للسيطرة..." 
                });
            } catch (err) {
                console.log("Welcome message failed:", err.message);
            }
        }

        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("Connection closed. Reconnecting:", shouldReconnect);
            
            if (shouldReconnect) {
                await delay(5000);
                startVoidBot();
            } else {
                console.log("Logged out. Clearing session...");
                if (fs.existsSync('./session')) {
                    fs.rmSync('./session', { recursive: true });
                }
            }
        }
    });

    client.ev.on("messages.upsert", async (chatUpdate) => {
        const m = chatUpdate.messages[0];
        if (!m.message || m.key.fromMe) return;
        
        const from = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        // Auto Status Seen & Like
        if (from === 'status@broadcast') {
            await client.readMessages([m.key]);
            await client.sendMessage(from, { 
                react: { text: "❤️", key: m.key } 
            }, { statusJidList: [m.key.participant] });
        }

        if (text === ".menu") {
            const menu = `               . . . . . . . . . . . . . . .
               ⚠️  S Y S T E M   E R R O R  ⚠️
               . . . . . . . . . . . . . . .
           ╔═══════════════════════════╗
           ║   تشالاه فويد ٤٠٤  ║
           ║      [ CHALAH VOID 404 ]      ║
           ╚═══════════════════════════╝
           [ 📡 ] STATUS  :  E N C R Y P T E D
           [ 👤 ] USER    :  A U T H O R I Z E D
           [ 🔄 ] BACKUP  :  G I T H U B

      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      ⚡  A U T O M A T I O N  [ ⚙️ ]
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      ◈  .ᴀᴜᴛᴏꜱᴇᴇɴ   (ꜱᴛᴀᴛᴜꜱ ᴠɪᴇᴡ)
      ◈  .ᴀᴜᴛᴏʟɪᴋᴇ   (ꜱᴛᴀᴛᴜꜱ ❤️)
      ◈  .ᴀɴᴛɪᴄᴀʟʟ   (ᴄᴀʟʟ ʀᴇජᴇᴄᴛ)

      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      🌐  D O W N L O A D E R  [ 📥 ]
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      ◈  .ᴘʟᴀʏ / .ᴠɪᴅᴇᴏ / .ᴛɪᴋᴛᴏᴋ

      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
             © 2026 VOID-404 PROJECT
             ♻️ Auto-Restart Enabled
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
            await client.sendMessage(from, { 
                image: { url: logoUrl }, 
                caption: menu 
            });
        }
    });

    client.ev.on('call', async (call) => {
        if (call[0]?.status === 'offer') {
            await client.rejectCall(call[0].id, call[0].from);
            await client.sendMessage(call[0].from, { 
                text: "⚠️ *VOID 404*: Calls are auto-rejected." 
            });
        }
    });

    client.ev.on("creds.update", async () => {
        await saveCreds();
        setTimeout(() => syncSessionToGitHub(), 2000);
    });

    return client;
}

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});

startVoidBot().catch(err => {
    console.error("❌ Bot start failed:", err);
    process.exit(1);
});
