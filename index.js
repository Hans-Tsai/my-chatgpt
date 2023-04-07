"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { Configuration, OpenAIApi } = require("openai");
const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);
const ngrok = require("ngrok");

//#region Cronjob
// Schedule a task to delete all files in the "downloaded/" folder every day at midnight
cron.schedule(
    "0 0 * * *",
    () => {
        // Use the fs.readdir() method to get a list of all files in the "downloaded/" folder
        fs.readdir("./downloaded/", (err, files) => {
            if (err) throw err;

            // Use the fs.unlink() method to delete each file in the "downloaded/" folder
            for (const file of files) {
                if (file == ".gitkeep") continue;
                fs.unlink(`./downloaded/${file}`, (err) => {
                    if (err) throw err;
                });
            }
        });
    },
    {
        scheduled: true,
        timezone: "Asia/Taipei", // Change timezone to yours
    }
);

//#endregion

//#region Environment Variables Configuration
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

//#endregion

//#region Using Express framework to build up a Line Chatbot server
const app = express();
// serve static and downloaded files
app.use("/static", express.static("static"));
app.use("/downloaded", express.static("downloaded"));

app.get("/webhook", (req, res) =>
    res.end(`I'm listening. Please access with POST.`)
);
app.post("/webhook", line.middleware(config), (req, res) => {
    if (req.body.destination) {
        console.log("Destination User ID: " + req.body.destination);
    }

    // req.body.events should be an array of events
    if (!Array.isArray(req.body.events)) {
        return res.status(500).end();
    }

    Promise.all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

//#endregion

// simple reply function
const replyText = (token, texts) => {
    texts = Array.isArray(texts) ? texts : [texts];
    return client.replyMessage(
        token,
        texts.map((text) => ({ type: "text", text }))
    );
};

// Download Content tool function
function downloadContent(messageId, downloadPath) {
    return client.getMessageContent(messageId).then(
        (stream) =>
            new Promise((resolve, reject) => {
                const writable = fs.createWriteStream(downloadPath);
                stream.pipe(writable);
                stream.on("end", () => resolve(downloadPath));
                stream.on("error", reject);
            })
    );
}

// Webhook main function (handling webhook events based on its event type)
function handleEvent(event) {
    if (event.replyToken && event.replyToken.match(/^(.)\1*$/)) {
        return console.log(
            "Test hook recieved: " + JSON.stringify(event.message)
        );
    }

    switch (event.type) {
        case "message":
            const message = event.message;
            switch (message.type) {
                case "text":
                    return handleText(event);
                case "image":
                    return handleImage(message, event.replyToken);
                case "video":
                    return handleVideo(message, event.replyToken);
                case "audio":
                    return handleAudio(message, event.replyToken);
                case "location":
                    return handleLocation(message, event.replyToken);
                case "sticker":
                    return handleSticker(message, event.replyToken);
                default:
                    throw new Error(
                        `Unknown message: ${JSON.stringify(message)}`
                    );
            }

        case "follow":
            return replyText(event.replyToken, "Got followed event");

        case "unfollow":
            return console.log(`Unfollowed this bot: ${JSON.stringify(event)}`);

        case "join":
            return replyText(event.replyToken, `Joined ${event.source.type}`);

        case "leave":
            return console.log(`Left: ${JSON.stringify(event)}`);

        case "postback":
            let data = event.postback.data;
            if (data === "DATE" || data === "TIME" || data === "DATETIME") {
                data += `(${JSON.stringify(event.postback.params)})`;
            }
            return replyText(event.replyToken, `Got postback: ${data}`);

        case "beacon":
            return replyText(
                event.replyToken,
                `Got beacon: ${event.beacon.hwid}`
            );

        default:
            throw new Error(`Unknown event: ${JSON.stringify(event)}`);
    }
}

//#region Handler functions
// handle text by ChatGPT feature
function handleText(event) {
    return openai
        .createCompletion({
            prompt: event.message.text,
            model: "text-davinci-003",
            max_tokens: 500,
        })
        .then((completions) => {
            const message = completions.data.choices[0].text.trim();
            console.log({ OpenAI_Message: message });
            return client.replyMessage(event.replyToken, {
                type: "text",
                text: message,
            });
        });
}

function handleImage(message, replyToken) {
    let getContent;
    if (message.contentProvider.type === "line") {
        const downloadPath = path.join(
            __dirname,
            "downloaded",
            `${message.id}.jpg`
        );
        const previewPath = path.join(
            __dirname,
            "downloaded",
            `${message.id}-preview.jpg`
        );

        getContent = downloadContent(message.id, downloadPath).then(
            (downloadPath) => {
                // ImageMagick is needed here to run 'convert'
                // Please consider about security and performance by yourself
                cp.execSync(
                    `convert -resize 240x jpeg:${downloadPath} jpeg:${previewPath}`
                );

                console.log({
                    originalContentUrl:
                        baseURL + "/downloaded/" + path.basename(downloadPath),
                    previewImageUrl:
                        baseURL + "/downloaded/" + path.basename(previewPath),
                });

                return {
                    originalContentUrl:
                        baseURL + "/downloaded/" + path.basename(downloadPath),
                    previewImageUrl:
                        baseURL + "/downloaded/" + path.basename(previewPath),
                };
            }
        );
    } else if (message.contentProvider.type === "external") {
        getContent = Promise.resolve(message.contentProvider);
    }

    return getContent.then(({ originalContentUrl, previewImageUrl }) => {
        return client.replyMessage(replyToken, {
            type: "image",
            originalContentUrl,
            previewImageUrl,
        });
    });
}

function handleVideo(message, replyToken) {
    let getContent;
    if (message.contentProvider.type === "line") {
        const downloadPath = path.join(
            __dirname,
            "downloaded",
            `${message.id}.mp4`
        );
        const previewPath = path.join(
            __dirname,
            "downloaded",
            `${message.id}-preview.jpg`
        );

        getContent = downloadContent(message.id, downloadPath).then(
            (downloadPath) => {
                // FFmpeg and ImageMagick is needed here to run 'convert'
                // Please consider about security and performance by yourself
                cp.execSync(
                    `convert mp4:${downloadPath}[0] jpeg:${previewPath}`
                );

                return {
                    originalContentUrl:
                        baseURL + "/downloaded/" + path.basename(downloadPath),
                    previewImageUrl:
                        baseURL + "/downloaded/" + path.basename(previewPath),
                };
            }
        );
    } else if (message.contentProvider.type === "external") {
        getContent = Promise.resolve(message.contentProvider);
    }

    return getContent.then(({ originalContentUrl, previewImageUrl }) => {
        return client.replyMessage(replyToken, {
            type: "video",
            originalContentUrl,
            previewImageUrl,
        });
    });
}

function handleAudio(message, replyToken) {
    let getContent;
    if (message.contentProvider.type === "line") {
        const downloadPath = path.join(
            __dirname,
            "downloaded",
            `${message.id}.m4a`
        );

        getContent = downloadContent(message.id, downloadPath).then(
            (downloadPath) => {
                return {
                    originalContentUrl:
                        baseURL + "/downloaded/" + path.basename(downloadPath),
                };
            }
        );
    } else {
        getContent = Promise.resolve(message.contentProvider);
    }

    return getContent.then(({ originalContentUrl }) => {
        return client.replyMessage(replyToken, {
            type: "audio",
            originalContentUrl,
            duration: message.duration,
        });
    });
}

function handleLocation(message, replyToken) {
    return client.replyMessage(replyToken, {
        type: "location",
        title: message.title,
        address: message.address,
        latitude: message.latitude,
        longitude: message.longitude,
    });
}

function handleSticker(message, replyToken) {
    return client.replyMessage(replyToken, {
        type: "sticker",
        packageId: message.packageId,
        stickerId: message.stickerId,
    });
}

//#endregion

//#region Start up a Line Chatbot server
// listen on port
const port = process.env.PORT || 3000;
let baseURL = process.env.BASE_URL || "";
const authtoken = process.env.authtoken || "";
app.listen(port, () => {
    if (baseURL) {
        console.log(`listening on ${baseURL}/webhook`);
    } else {
        console.log(
            "It seems that BASE_URL is not set. Connecting to ngrok..."
        );
        ngrok
            .connect({ authtoken, port })
            .then((url) => {
                baseURL = url;
                console.log(`listening on ${baseURL}/webhook`);
            })
            .catch(console.error);
    }
});

//#endregion