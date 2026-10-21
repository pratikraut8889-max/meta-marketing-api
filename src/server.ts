import "dotenv/config";
import express from "express";
import session from "express-session";
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto'; // Built-in Node.js module for unique IDs

declare module "express-session" {
    interface SessionData {
        metaOauthState?: string;
        metaAccessToken?: string;
        metaTokenExpiresAt?: number;
    }
}

const app = express();

const {
    PORT = "3000",
    SESSION_SECRET,
    META_APP_ID,
    META_APP_SECRET,
    META_LOGIN_CONFIG_ID,
    META_REDIRECT_URI,
    META_GRAPH_API_VERSION = "v25.0",
} = process.env;

if (
    !SESSION_SECRET ||
    !META_APP_ID ||
    !META_APP_SECRET ||
    !META_LOGIN_CONFIG_ID ||
    !META_REDIRECT_URI
) {
    throw new Error("Missing required settings in .env");
}
app.use(express.json()); // Parse JSON request bodies   

// For local development only. Use a persistent session store in production.
app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: false, // Local HTTP only; enable HTTPS-secure cookies in production.
            maxAge: 60 * 60 * 1000,
        },
    }),
);

app.get("/", (_req, res) => {
    res.send(`
    <h1>Meta Ads Sample</h1>
    <p>OAuth login test — no campaigns will be changed.</p>
    <a href="/auth/meta">Connect Meta Ads</a>
  `);
});

// Step A: Start Facebook Login for Business.
app.get("/auth/meta", (req, res, next) => {
    req.session.metaOauthState = crypto.randomBytes(32).toString("hex");

    req.session.save((error) => {
        if (error) {
            return next(error);
        }

        const loginUrl = new URL(
            `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`,
        );

        loginUrl.searchParams.set("client_id", META_APP_ID);
        loginUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
        loginUrl.searchParams.set("config_id", META_LOGIN_CONFIG_ID);
        loginUrl.searchParams.set("response_type", "code");
        loginUrl.searchParams.set("state", req.session.metaOauthState!);

        // The Business Login configuration contains the selected permissions.
        res.redirect(loginUrl.toString());
    });
});

// Step B: Receive the authorization code and exchange it server-side.
app.get("/auth/meta/callback", async (req, res) => {
    try {
        const metaError =
            typeof req.query.error === "string" ? req.query.error : undefined;

        if (metaError) {
            return res
                .status(400)
                .send("Meta login was cancelled or denied. Return home and try again.");
        }

        const code = typeof req.query.code === "string"
            ? req.query.code
            : undefined;

        const returnedState = typeof req.query.state === "string"
            ? req.query.state
            : undefined;

        if (
            !code ||
            !returnedState ||
            !req.session.metaOauthState ||
            returnedState !== req.session.metaOauthState
        ) {
            return res
                .status(400)
                .send("Invalid OAuth response. Please start login again.");
        }

        delete req.session.metaOauthState;

        const tokenUrl = new URL(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
        );

        tokenUrl.searchParams.set("client_id", META_APP_ID);
        tokenUrl.searchParams.set("client_secret", META_APP_SECRET);
        tokenUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
        tokenUrl.searchParams.set("code", code);

        const tokenResponse = await fetch(tokenUrl);
        const tokenData = (await tokenResponse.json()) as {
            access_token?: string;
            expires_in?: number;
            error?: { message?: string };
        };

        if (!tokenResponse.ok || !tokenData.access_token) {
            console.error(
                "Meta token exchange failed:",
                tokenData.error?.message ?? "Unknown Meta API error",
            );

            return res
                .status(502)
                .send("Meta did not return an access token. Check your terminal logs.");
        }

        // Keep the token server-side; never send it to the browser.
        req.session.metaAccessToken = tokenData.access_token;


        if (typeof tokenData.expires_in === "number") {
            req.session.metaTokenExpiresAt =
                Date.now() + tokenData.expires_in * 1000;
        } else {
            delete req.session.metaTokenExpiresAt;
        }
        const tokenFile = path.join(import.meta.dirname, "..", "data", "token.json");
        console.log("Storing Meta access token in:", tokenFile);
        const payload = {
            id: crypto.randomUUID(),
            access_token: tokenData.access_token
        };

        // fs.writeFile automatically overwrites/clears the existing file content
        await fs.writeFile(tokenFile, JSON.stringify(payload, null, 2), "utf-8");

        await new Promise<void>((resolve, reject) => {
            req.session.save((error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        res.send(`
      <h1>Meta OAuth login succeeded!</h1>
      <p>Your server received and stored an access token in this development session.</p>
      <p>The token has not been displayed in the browser.</p>
      <a href="/">Return home</a>
    `);
    } catch (error) {
        console.error(
            "OAuth callback failed:",
            error instanceof Error ? error.message : "Unknown error",
        );

        res.status(500).send("OAuth failed. Check the server terminal for details.");
    }
});

app.get("/meta/ad-accounts", async (req, res) => {
    const filesdata = (await fs.readFile(path.join(import.meta.dirname, "..", "data", "token.json"), "utf-8"));
    console.log("Read token.json:", filesdata);
    const tokenData = JSON.parse(filesdata);

    if (!tokenData.access_token) {
        return res.status(401).send(
            "Please connect Meta Ads first."
        );
    }

    try {
        const url = new URL(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/adaccounts`
        );

        url.searchParams.set(
            "fields",
            "id,name,account_status,currency"
        );

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
            },
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("Meta API request failed:", data);
            return res.status(response.status).json(data);
        }

        return res.json(data);
    } catch (error) {
        console.error("Ad account request failed:", error);
        return res.status(500).send("Could not retrieve ad accounts.");
    }
});

app.get(
    "/meta/ad-accounts/:adAccountId/campaigns",
    async (req, res) => {

        const filesdata = (await fs.readFile(path.join(import.meta.dirname, "..", "data", "token.json"), "utf-8"));
        console.log("Read token.json:", filesdata);
        const tokenData = JSON.parse(filesdata);
        const accessToken = tokenData.access_token;
        console.log("Access token from token.json:", accessToken);
        const { adAccountId } = req.params;

        // Require an existing Meta login.
        if (!accessToken) {
            return res.status(401).json({
                error: "Connect your Meta account first.",
            });
        }

        // Accept only IDs in the format act_123456789.
        if (!/^act_\d+$/.test(adAccountId)) {
            return res.status(400).json({
                error: "Invalid ad account ID.",
            });
        }

        const url = new URL(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${adAccountId}/campaigns`
        );

        url.searchParams.set(
            "fields",
            "id,name,objective,status,effective_status"
        );

        try {
            const metaResponse = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            });

            const data = await metaResponse.json();

            if (!metaResponse.ok) {
                console.error("Meta campaigns API error:", data);

                return res.status(metaResponse.status).json({
                    error: "Meta API request failed.",
                    details: data,
                });
            }

            return res.json(data);
        } catch (error) {
            console.error("Failed to reach Meta API:", error);

            return res.status(502).json({
                error: "Could not reach Meta Graph API.",
            });
        }
    }
);

app.post("/meta/campaigns/:campaignId/pause", async (req, res) => {
    const filesdata = (await fs.readFile(path.join(import.meta.dirname, "..", "data", "token.json"), "utf-8"));
    const tokenData = JSON.parse(filesdata);
    const accessToken = tokenData.access_token;
    const { campaignId } = req.params;

    if (!accessToken) {
        return res.status(401).json({
            error: "Connect your Meta account first.",
        });
    }

    if (!/^\d+$/.test(campaignId)) {
        return res.status(400).json({
            error: "Invalid campaign ID.",
        });
    }

    try {
        const url = new URL(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${campaignId}`
        );

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                status: "PAUSED",
            }).toString(),
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: "Failed to pause campaign.",
                details: data,
            });
        }

        return res.json({
            message: "Campaign paused successfully.",
            data,
        });
    } catch (error) {
        console.error("Pause campaign error:", error);

        return res.status(502).json({
            error: "Could not reach Meta Graph API.",
        });
    }
});

app.get("/meta/permissions", async (req, res) => {
    const filesdata = (await fs.readFile(path.join(import.meta.dirname, "..", "data", "token.json"), "utf-8"));
    console.log("Read token.json:", filesdata);
    const tokenData = JSON.parse(filesdata);
    if (!tokenData.access_token) {
        return res.status(401).json({
            error: "Connect your Meta account first.",
        });
    }

    try {
        const url = new URL(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/permissions`
        );

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
            },
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("Meta permissions error:", data);

            return res.status(response.status).json({
                error: "Could not retrieve Meta permissions.",
            });
        }

        return res.json(data);
    } catch (error) {
        console.error("Permissions request failed:", error);

        return res.status(502).json({
            error: "Could not reach Meta Graph API.",
        });
    }
});


app.post(
    "/meta/ad-accounts/:adAccountId/campaigns",
    async (req, res) => {
        const filesdata = (await fs.readFile(path.join(import.meta.dirname, "..", "data", "token.json"), "utf-8"));
        console.log("Read token.json:", filesdata);
        const tokenData = JSON.parse(filesdata);
        const { adAccountId } = req.params;

        if (!tokenData.access_token) {
            return res.status(401).json({
                error: "Connect your Meta account first.",
            });
        }

        if (!/^act_\d+$/.test(adAccountId)) {
            return res.status(400).json({
                error: "Invalid ad account ID.",
            });
        }

        const name =
            typeof req.body?.name === "string"
                ? req.body.name.trim()
                : "";

        console.log(
            "name length", name.length
        );

        if (!name || name.length > 100) {
            return res.status(400).json({
                error: "Campaign name is required and must be at most 100 characters.",
            });
        }

        const url = new URL(
            `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${adAccountId}/campaigns`
        );

        const params = new URLSearchParams({
            name,
            objective: "OUTCOME_TRAFFIC",
            status: "PAUSED",
            special_ad_categories: "NONE",
            is_adset_budget_sharing_enabled: "false",
        });

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${tokenData.access_token}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: params.toString(),
            });

            const data = await response.json();

            if (!response.ok) {
                console.error("Meta campaign creation error:", data);

                return res.status(response.status).json({
                    error: "Meta campaign creation failed.",
                    details: data,
                });
            }

            return res.status(201).json(data);
        } catch (error) {
            console.error("Meta API request failed:", error);

            return res.status(502).json({
                error: "Could not reach Meta Graph API.",
            });
        }
    }
);


app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});