import axios, { isAxiosError } from "axios";
import { config } from "../config.js";
import { graphUrl } from "./constants.js";

function pageToken(): string {
  const t = config.metaPageAccessToken.trim();
  if (!t) throw new Error("META_PAGE_ACCESS_TOKEN no configurado");
  return t;
}

function logAxiosError(context: string, e: unknown): void {
  if (isAxiosError(e) && e.response?.data) {
    console.error(`[meta-send] ${context}:`, JSON.stringify(e.response.data));
  } else {
    console.error(`[meta-send] ${context}:`, e);
  }
}

export async function sendMessengerText(psid: string, body: string): Promise<void> {
  const text = body.slice(0, 2000);
  try {
    await axios.post(
      graphUrl("me/messages"),
      {
        messaging_type: "RESPONSE",
        recipient: { id: psid },
        message: { text },
      },
      {
        headers: {
          Authorization: `Bearer ${pageToken()}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
  } catch (e) {
    logAxiosError("Messenger", e);
    throw e;
  }
}

export async function sendInstagramDmText(igsid: string, body: string): Promise<void> {
  const text = body.slice(0, 2000);
  try {
    await axios.post(
      graphUrl("me/messages"),
      {
        messaging_type: "RESPONSE",
        recipient: { id: igsid },
        messaging_product: "instagram",
        message: { text },
      },
      {
        headers: {
          Authorization: `Bearer ${pageToken()}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
  } catch (e) {
    logAxiosError("Instagram DM", e);
    throw e;
  }
}

export async function replyToFacebookComment(commentId: string, body: string): Promise<void> {
  const message = body.slice(0, 8000);
  try {
    await axios.post(
      graphUrl(`${commentId}/comments`),
      { message },
      {
        headers: {
          Authorization: `Bearer ${pageToken()}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
  } catch (e) {
    logAxiosError("Facebook comment reply", e);
    throw e;
  }
}

export async function replyToInstagramComment(commentId: string, body: string): Promise<void> {
  const message = body.slice(0, 2000);
  try {
    await axios.post(
      graphUrl(`${commentId}/replies`),
      { message },
      {
        headers: {
          Authorization: `Bearer ${pageToken()}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
  } catch (e) {
    logAxiosError("Instagram comment reply", e);
    throw e;
  }
}
