const config = require('../config');
const { cmd } = require('../command');
const yts = require('yt-search');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const princeVideoApi = {
    base: 'https://api.princetechn.com/api/download/ytmp4',
    apikey: process.env.PRINCE_API_KEY || 'prince',
    async fetchMeta(videoUrl) {
        const params = new URLSearchParams({ apikey: this.apikey, url: videoUrl });
        const url = `${this.base}?${params.toString()}`;
        const { data } = await axios.get(url, { timeout: 20000, headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
        return data;
    }
};

cmd({
    pattern: "video",
    alias: ["mp4", "song"],
    react: "🎥",
    desc: "Download video from YouTube",
    category: "download",
    use: ".video <query or url>",
    filename: __filename
}, async (conn, m, mek, { from, q, reply }) => {
    try {
        if (!q) return await reply("❌ What video do you want to download?");

        let videoUrl = '';
        let videoTitle = '';
        let videoThumbnail = '';
        
        // Determine if input is a YouTube link
        if (q.startsWith('http://') || q.startsWith('https://')) {
            videoUrl = q;
        } else {
            // Search YouTube for the video
            const { videos } = await yts(q);
            if (!videos || videos.length === 0) {
                return await reply("❌ No videos found!");
            }
            videoUrl = videos[0].url;
            videoTitle = videos[0].title;
            videoThumbnail = videos[0].thumbnail;
        }

        // Send thumbnail immediately
        try {
            const ytId = (videoUrl.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/) || [])[1];
            const thumb = videoThumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/sddefault.jpg` : undefined);
            const captionTitle = videoTitle || q;
            if (thumb) {
                await conn.sendMessage(from, {
                    image: { url: thumb },
                    caption: `*${captionTitle}*\nDownloading...`
                }, { quoted: mek });
            }
        } catch (e) { 
            console.error('[VIDEO] thumb error:', e?.message || e); 
        }

        // Validate YouTube URL
        let urls = videoUrl.match(/(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|v\/|embed\/|shorts\/|playlist\?list=)?)([a-zA-Z0-9_-]{11})/gi);
        if (!urls) {
            return await reply("❌ This is not a valid YouTube link!");
        }

        // PrinceTech video API
        let videoDownloadUrl = '';
        let title = '';
        try {
            const meta = await princeVideoApi.fetchMeta(videoUrl);
            if (meta?.success && meta?.result?.download_url) {
                videoDownloadUrl = meta.result.download_url;
                title = meta.result.title || 'video';
            } else {
                return await reply("❌ Failed to fetch video from the API.");
            }
        } catch (e) {
            console.error('[VIDEO] prince api error:', e?.message || e);
            return await reply("❌ Failed to fetch video from the API.");
        }
        
        const filename = `${title}.mp4`;

        // Try sending the video directly from the remote URL
        try {
            await conn.sendMessage(from, {
                video: { url: videoDownloadUrl },
                mimetype: 'video/mp4',
                fileName: filename,
                caption: `*${title}*\n\n> *THIS IS DARKZONE-MD baby*`
            }, { quoted: mek });
            return;
        } catch (directSendErr) {
            console.log('[video.js] Direct send from URL failed:', directSendErr.message);
        }

        // If direct send fails, fallback to downloading and converting
        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        const tempFile = path.join(tempDir, `${Date.now()}.mp4`);
        const convertedFile = path.join(tempDir, `converted_${Date.now()}.mp4`);
        
        let buffer;
        let download403 = false;
        try {
            const videoRes = await axios.get(videoDownloadUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Referer': 'https://youtube.com/'
                },
                responseType: 'arraybuffer'
            });
            buffer = Buffer.from(videoRes.data);
        } catch (err) {
            if (err.response && err.response.status === 403) {
                download403 = true;
            } else {
                return await reply("❌ Failed to download the video file.");
            }
        }
        
        // Fallback: try another URL if 403
        if (download403) {
            let altUrl = videoDownloadUrl.replace(/(cdn|s)\d+/, 's5');
            try {
                const videoRes = await axios.get(altUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                        'Referer': 'https://youtube.com/'
                    },
                    responseType: 'arraybuffer'
                });
                buffer = Buffer.from(videoRes.data);
            } catch (err2) {
                return await reply("❌ Failed to download the video file from alternate CDN.");
            }
        }
        
        if (!buffer || buffer.length < 1024) {
            return await reply("❌ Downloaded file is empty or too small.");
        }
        
        fs.writeFileSync(tempFile, buffer);

        try {
            await execPromise(`ffmpeg -i "${tempFile}" -c:v libx264 -c:a aac -preset veryfast -crf 26 -movflags +faststart "${convertedFile}"`);
            
            if (!fs.existsSync(convertedFile)) {
                return await reply("❌ Converted file missing.");
            }
            
            const stats = fs.statSync(convertedFile);
            const maxSize = 62 * 1024 * 1024; // 62MB
            if (stats.size > maxSize) {
                return await reply("❌ Video is too large to send on WhatsApp.");
            }
            
            // Try sending the converted video
            try {
                await conn.sendMessage(from, {
                    video: { url: convertedFile },
                    mimetype: 'video/mp4',
                    fileName: filename,
                    caption: `*${title}*`
                }, { quoted: mek });
            } catch (sendErr) {
                console.error('[VIDEO] send url failed, trying buffer:', sendErr?.message || sendErr);
                const videoBuffer = fs.readFileSync(convertedFile);
                await conn.sendMessage(from, {
                    video: videoBuffer,
                    mimetype: 'video/mp4',
                    fileName: filename,
                    caption: `*${title}*`
                }, { quoted: mek });
            }
            
        } catch (conversionError) {
            console.error('[VIDEO] conversion failed, trying original file:', conversionError?.message || conversionError);
            
            try {
                if (!fs.existsSync(tempFile)) {
                    return await reply("❌ Temp file missing.");
                }
                
                const origStats = fs.statSync(tempFile);
                const maxSize = 62 * 1024 * 1024; // 62MB
                if (origStats.size > maxSize) {
                    return await reply("❌ Video is too large to send on WhatsApp.");
                }
                
                // Try sending the original file
                try {
                    await conn.sendMessage(from, {
                        video: { url: tempFile },
                        mimetype: 'video/mp4',
                        fileName: filename,
                        caption: `*${title}*`
                    }, { quoted: mek });
                } catch (sendErr2) {
                    console.error('[VIDEO] send original url failed, trying buffer:', sendErr2?.message || sendErr2);
                    const videoBuffer = fs.readFileSync(tempFile);
                    await conn.sendMessage(from, {
                        video: videoBuffer,
                        mimetype: 'video/mp4',
                        fileName: filename,
                        caption: `*${title}*`
                    }, { quoted: mek });
                }
            } catch (error) {
                return await reply("❌ Error processing video file.");
            }
        }

        // Clean up temp files
        setTimeout(() => {
            try {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                if (fs.existsSync(convertedFile)) fs.unlinkSync(convertedFile);
            } catch (cleanupErr) {
                console.error('[VIDEO] cleanup error:', cleanupErr?.message || cleanupErr);
            }
        }, 3000);

    } catch (error) {
        console.error('[VIDEO] Command Error:', error?.message || error);
        await reply(`❌ Download failed: ${error?.message || 'Unknown error'}`);
    }
});
