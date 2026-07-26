import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export type WechatIlinkUpdate = {
  updateId: string;
  fromUserId: string;
  fromDisplayName: string;
  text: string;
  contextToken: string;
  messageType: 1 | 2 | 3 | 4 | 5;
  itemList?: Array<{ type: number; text_item?: { text: string } }>;
  timestamp: string;
  messageId?: string;
};

export type WechatIlinkMediaRef = {
  cdnUrl: string;
  aesKey: string;
  name: string;
  mimeType: string;
  size?: number;
};

type WechatBotSession = {
  botToken: string;
  baseUrl: string;
  accountId?: string;
};

type IlinkUploadUrlResponse = {
  ret?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
};

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const AES_BLOCK_SIZE = 16;

async function fetchIlink(url: URL, init: RequestInit, resourcePath: string): Promise<Response> {
  try {
    return await fetch(url.toString(), init);
  } catch (error) {
    throw new Error(`ilink ${resourcePath} fetch failed at ${safeIlinkUrl(url)}: ${describeFetchFailure(error)}`);
  }
}

function normalizeIlinkBaseUrl(value?: string | null): string {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed || ILINK_BASE;
}

function safeIlinkUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function describeFetchFailure(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error && error.message) parts.push(error.message);
  else parts.push(String(error));

  const cause = error && typeof error === 'object' && 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    const causeParts = [
      stringField(record.code),
      stringField(record.syscall),
      stringField(record.hostname) ?? stringField(record.host),
      stringField(record.address),
      numberField(record.port),
      stringField(record.message),
    ].filter(Boolean);
    if (causeParts.length > 0) parts.push(`cause=${causeParts.join(' ')}`);
  } else if (cause) {
    parts.push(`cause=${String(cause)}`);
  }

  return parts.join('; ');
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstArrayField(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = arrayValue(record[key]);
    if (value.length > 0) return value;
  }
  return [];
}

function extractIlinkMessages(data: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    firstArrayField(data, ['msgs', 'messages', 'msg_list', 'message_list', 'updates', 'update_list']),
  ];
  const nested = asRecord(data.data) ?? asRecord(data.result);
  if (nested) {
    candidates.push(firstArrayField(nested, ['msgs', 'messages', 'msg_list', 'message_list', 'updates', 'update_list']));
  }
  return candidates.flat().map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
}

function extractIlinkText(message: Record<string, unknown>): string {
  const direct = stringValue(message.text) ?? stringValue(message.content);
  if (direct) return direct;

  const content = asRecord(message.content);
  const contentText = content ? stringValue(content.text) ?? stringValue(content.content) : undefined;
  if (contentText) return contentText;

  for (const item of arrayValue(message.item_list ?? message.items)) {
    const itemRecord = asRecord(item);
    if (!itemRecord) continue;
    const textItem = asRecord(itemRecord.text_item) ?? asRecord(itemRecord.textItem);
    const text = stringValue(textItem?.text) ?? stringValue(textItem?.content) ?? stringValue(itemRecord.text) ?? stringValue(itemRecord.content);
    if (text) return text;
  }

  return '';
}

function summarizeMessageTypes(messages: Record<string, unknown>[]): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const type = numberValue(message.message_type ?? message.msg_type ?? message.type);
    const key = type === undefined ? 'unknown' : String(type);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => `${type}:${count}`);
}

function summarizeIlinkMessage(message: Record<string, unknown>): Record<string, unknown> {
  return {
    messageId: stringValue(message.msg_id) ?? stringValue(message.message_id) ?? stringValue(message.id) ?? null,
    fromUserId: stringValue(message.from_user_id) ?? stringValue(message.fromUserId) ?? null,
    messageType: numberValue(message.message_type ?? message.msg_type ?? message.type) ?? null,
    itemTypes: arrayValue(message.item_list ?? message.items)
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => numberValue(item.type) ?? 'unknown'),
    textLength: extractIlinkText(message).length,
    hasContextToken: Boolean(stringValue(message.context_token) ?? stringValue(message.contextToken)),
  };
}

function arrayKeys(record: Record<string, unknown>): string[] {
  const keys = Object.entries(record).filter(([, value]) => Array.isArray(value)).map(([key]) => key);
  const nested = asRecord(record.data) ?? asRecord(record.result);
  if (nested) {
    keys.push(...Object.entries(nested).filter(([, value]) => Array.isArray(value)).map(([key]) => `nested.${key}`));
  }
  return keys;
}
function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0) >>> 0;
}

function xWechatUin(): string {
  return Buffer.from(String(randomUint32())).toString('base64');
}

function authHeaders(botToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': xWechatUin(),
  };
  if (botToken) h.Authorization = `Bearer ${botToken}`;
  return h;
}

function pkcs7Pad(bytes: Buffer): Buffer {
  const padLength = AES_BLOCK_SIZE - (bytes.length % AES_BLOCK_SIZE || AES_BLOCK_SIZE);
  return Buffer.concat([bytes, Buffer.alloc(padLength, padLength)]);
}

function pkcs7Unpad(bytes: Buffer): Buffer {
  if (bytes.length === 0 || bytes.length % AES_BLOCK_SIZE !== 0) return bytes;
  const padLength = bytes[bytes.length - 1] ?? 0;
  if (padLength <= 0 || padLength > AES_BLOCK_SIZE || padLength > bytes.length) return bytes;
  for (let index = bytes.length - padLength; index < bytes.length; index += 1) {
    if (bytes[index] !== padLength) return bytes;
  }
  return bytes.subarray(0, bytes.length - padLength);
}

function encryptAes128Ecb(bytes: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pkcs7Pad(bytes)), cipher.final()]);
}

function decryptAes128Ecb(bytes: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  return pkcs7Unpad(Buffer.concat([decipher.update(bytes), decipher.final()]));
}

function aesEcbPaddedSize(plaintextLength: number): number {
  return plaintextLength + (AES_BLOCK_SIZE - (plaintextLength % AES_BLOCK_SIZE || AES_BLOCK_SIZE));
}

function ensureImageName(name: string, mimeType: string): string {
  const extMap: Record<string, string> = {
    'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  };
  const ext = extMap[mimeType.toLowerCase()] ?? 'jpg';
  const trimmed = name.trim();
  if (trimmed && /\.[a-z0-9]+$/i.test(trimmed)) return trimmed;
  return `${trimmed || `image-${Date.now()}`}.${ext}`;
}

function ilinkMediaType(mimeType: string): number {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) return 1;
  if (lower.startsWith('video/')) return 2;
  if (lower.startsWith('audio/')) return 4;
  return 3;
}

export type WechatIlinkClient = {
  getQrCode(): Promise<{ qrcode: string; scanUrl: string }>;
  setBotToken(botToken: string, baseUrl?: string | null): void;
  checkQrCodeStatus(qrcode: string): Promise<{
    status: 'pending' | 'confirmed' | 'expired';
    botToken?: string;
    baseUrl?: string;
    displayName?: string;
    externalUserId?: string;
  }>;
  getUpdates(cursor: string): Promise<{ cursor: string; updates: WechatIlinkUpdate[] }>;
  sendText(input: { to: string; text: string; contextToken: string }): Promise<void>;
  sendImage(input: { to: string; bytes: Buffer; name: string; mimeType: string; contextToken: string }): Promise<void>;
  sendFile(input: { to: string; bytes: Buffer; name: string; mimeType: string; contextToken: string }): Promise<void>;
  downloadMedia?(input: WechatIlinkMediaRef): Promise<{ bytes: Buffer; mimeType: string; name: string }>;
};

export function createWechatIlinkClient(storedBotToken?: string | null, storedBaseUrl?: string | null): WechatIlinkClient {
  let session: WechatBotSession | null = storedBotToken
    ? { botToken: storedBotToken, baseUrl: normalizeIlinkBaseUrl(storedBaseUrl) }
    : null;

  async function apiGet<T>(resourcePath: string, params?: Record<string, string>, token?: string, baseUrl = ILINK_BASE): Promise<T> {
    const url = new URL(resourcePath.replace(/^\/+/, ''), `${normalizeIlinkBaseUrl(baseUrl)}/`);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const response = await fetchIlink(url, { headers: authHeaders(token) }, resourcePath);
    if (!response.ok) throw new Error(`ilink ${resourcePath} ${response.status}`);
    return response.json() as T;
  }

  async function apiPost<T>(resourcePath: string, body: unknown, token?: string, baseUrl = ILINK_BASE): Promise<T> {
    const url = new URL(resourcePath.replace(/^\/+/, ''), `${normalizeIlinkBaseUrl(baseUrl)}/`);
    const response = await fetchIlink(url, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }, resourcePath);
    const rawText = await response.text();
    if (!response.ok) throw new Error(`ilink ${resourcePath} ${response.status}: ${rawText.slice(0, 200)}`);
    if (!rawText.trim()) return {} as T;
    return JSON.parse(rawText) as T;
  }
  async function uploadEncryptedMedia(
    toUserId: string,
    bytes: Buffer,
    _mimeType: string,
    _name: string,
    mediaType: number = 1,
  ): Promise<{ downloadEncryptedQueryParam: string; aesKeyBase64: string; fileSizeCiphertext: number }> {
    if (!session) throw new Error('Not connected');

    const aesKey = randomBytes(16);
    const encryptedBytes = encryptAes128Ecb(bytes, aesKey);
    const rawSize = bytes.length;
    const fileSize = aesEcbPaddedSize(rawSize);
    const rawFileMd5 = createHash('md5').update(bytes).digest('hex');
    const fileKey = randomBytes(16).toString('hex');

    const uploadResponse = await apiPost<IlinkUploadUrlResponse>('/ilink/bot/getuploadurl', {
      filekey: fileKey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawFileMd5,
      filesize: fileSize,
      no_need_thumb: true,
      aeskey: aesKey.toString('hex'),
    }, session.botToken, session.baseUrl);

    if (uploadResponse.ret !== undefined && uploadResponse.ret !== 0) {
      throw new Error(`ilink getuploadurl ret ${uploadResponse.ret}${uploadResponse.errmsg ? `: ${uploadResponse.errmsg}` : ''}`);
    }

    const uploadFullUrl = uploadResponse.upload_full_url?.trim() || undefined;
    const uploadParam = uploadResponse.upload_param ?? undefined;
    if (!uploadFullUrl && !uploadParam) {
      throw new Error('ilink getuploadurl returned no upload URL');
    }

    const cdnUploadUrl = uploadFullUrl
      ?? `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam!)}&filekey=${encodeURIComponent(fileKey)}`;

    const maxRetries = 3;
    let downloadParam: string | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const uploadResult = await fetchIlink(new URL(cdnUploadUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(encryptedBytes.length),
        },
        body: new Uint8Array(encryptedBytes),
      }, '/ilink/cdn/upload');

      if (uploadResult.status >= 400 && uploadResult.status < 500) {
        const errMsg = uploadResult.headers.get('x-error-message') ?? await uploadResult.text().catch(() => '');
        throw new Error(`ilink CDN upload client error ${uploadResult.status}: ${errMsg.slice(0, 200)}`);
      }

      if (uploadResult.status !== 200) {
        if (attempt === maxRetries) {
          throw new Error(`ilink CDN upload failed after ${maxRetries} attempts: status ${uploadResult.status}`);
        }
        continue;
      }

      downloadParam = uploadResult.headers.get('x-encrypted-param') ?? undefined;
      if (downloadParam) break;
      throw new Error('ilink CDN upload response missing x-encrypted-param header');
    }

    return {
      downloadEncryptedQueryParam: downloadParam!,
      aesKeyBase64: Buffer.from(aesKey.toString('hex')).toString('base64'),
      fileSizeCiphertext: fileSize,
    };
  }

  return {
    setBotToken(botToken, baseUrl) {
      session = { botToken, baseUrl: normalizeIlinkBaseUrl(baseUrl) };
    },

    async getQrCode() {
      const data = await apiGet<{
        qrcode: string;
        qrcode_img_content: string;
      }>('/ilink/bot/get_bot_qrcode', { bot_type: '3' });
      return { qrcode: data.qrcode, scanUrl: data.qrcode_img_content };
    },

    async checkQrCodeStatus(qrcode) {
      const data = await apiGet<{
        ret?: number;
        status: string;
        bot_token?: string;
        baseurl?: string;
        nick_name?: string;
        user_id?: string;
      }>('/ilink/bot/get_qrcode_status', { qrcode });

      if (data.status === 'confirmed' && data.bot_token) {
        session = { botToken: data.bot_token, baseUrl: normalizeIlinkBaseUrl(data.baseurl) };
        console.info('[ilink] QR confirmed', { baseUrl: session.baseUrl, userId: data.user_id, displayName: data.nick_name });
        return {
          status: 'confirmed' as const,
          botToken: data.bot_token,
          baseUrl: session.baseUrl,
          displayName: data.nick_name,
          externalUserId: data.user_id ?? `ilink:${qrcode}`,
        };
      }

      if (data.status !== 'pending') {
        console.info('[ilink] QR status', { ret: data.ret, status: data.status });
      }
      return { status: data.status === 'expired' ? 'expired' as const : 'pending' as const };
    },

    async getUpdates(cursor) {
      if (!session) throw new Error('Not connected');
      const data = await apiPost<Record<string, unknown>>('/ilink/bot/getupdates', {
        get_updates_buf: cursor || '',
        base_info: { channel_version: '1.0.2' },
      }, session.botToken, session.baseUrl);

      const ret = numberValue(data.ret);
      if (ret !== undefined && ret !== 0) {
        throw new Error(`ilink getupdates ret ${ret}`);
      }

      const rawMessages = extractIlinkMessages(data);
      const nextCursor = stringValue(data.get_updates_buf) ?? stringValue(data.cursor) ?? cursor;
      const skipped: Record<string, unknown>[] = [];
      const updates: WechatIlinkUpdate[] = [];

      rawMessages.forEach((message, index) => {
        const text = extractIlinkText(message);
        const fromUserId = stringValue(message.from_user_id) ?? stringValue(message.fromUserId) ?? stringValue(message.sender) ?? '';
        if (!fromUserId || !text.trim()) {
          skipped.push(message);
          return;
        }

        const messageId = stringValue(message.msg_id) ?? stringValue(message.message_id) ?? stringValue(message.id);
        const messageType = numberValue(message.message_type ?? message.msg_type ?? message.type) ?? 1;
        updates.push({
          updateId: messageId ?? `${nextCursor || cursor || 'ilink'}-${index}`,
          messageId,
          fromUserId,
          fromDisplayName: fromUserId.split('@')[0] ?? '微信用户',
          text,
          contextToken: stringValue(message.context_token) ?? stringValue(message.contextToken) ?? '',
          messageType: (messageType >= 1 && messageType <= 5 ? messageType : 1) as WechatIlinkUpdate['messageType'],
          itemList: arrayValue(message.item_list ?? message.items) as WechatIlinkUpdate['itemList'],
          timestamp: new Date().toISOString(),
        });
      });

      if (rawMessages.length > 0) {
        console.info('[ilink] getupdates parsed', {
          rawCount: rawMessages.length,
          textCount: updates.length,
          skippedCount: skipped.length,
          messageTypes: summarizeMessageTypes(rawMessages),
          previousCursor: cursor || '',
          nextCursor,
        });
      }

      if (skipped.length > 0) {
        console.warn('[ilink] getupdates skipped messages', {
          skippedCount: skipped.length,
          samples: skipped.slice(0, 3).map(summarizeIlinkMessage),
        });
      }

      const keysWithArrays = arrayKeys(data);
      if (rawMessages.length === 0 && keysWithArrays.length > 0) {
        console.warn('[ilink] getupdates response had unrecognized message arrays', {
          topLevelKeys: Object.keys(data),
          arrayKeys: keysWithArrays,
        });
      }

      return { cursor: nextCursor, updates };
    },

    async sendText({ to, text, contextToken }) {
      if (!session) throw new Error('Not connected');
      const clientId = `viforge-${randomBytes(3).toString('hex')}`;
      await apiPost<Record<string, unknown>>('/ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: contextToken,
        },
      }, session.botToken, session.baseUrl);
    },

    async sendImage({ to, bytes, name, mimeType, contextToken }) {
      if (!session) throw new Error('Not connected');

      const fileName = ensureImageName(name, mimeType);
      const { downloadEncryptedQueryParam, aesKeyBase64, fileSizeCiphertext } = await uploadEncryptedMedia(to, bytes, mimeType, fileName);
      const clientId = `viforge-img-${randomBytes(3).toString('hex')}`;

      await apiPost<Record<string, unknown>>('/ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: downloadEncryptedQueryParam,
                aes_key: aesKeyBase64,
                encrypt_type: 1,
              },
              mid_size: fileSizeCiphertext,
            },
          }],
          context_token: contextToken,
        },
      }, session.botToken, session.baseUrl);

      console.info('[ilink] sendimage sent', { to, name: fileName, byteLength: bytes.length });
    },

    async sendFile({ to, bytes, name, mimeType, contextToken }) {
      if (!session) throw new Error('Not connected');

      const mediaType = ilinkMediaType(mimeType);
      const fileName = name.trim() || `file-${Date.now()}`;
      const { downloadEncryptedQueryParam, aesKeyBase64, fileSizeCiphertext } = await uploadEncryptedMedia(to, bytes, mimeType, fileName, mediaType);
      const clientId = `viforge-file-${randomBytes(3).toString('hex')}`;

      const cdnMedia = {
        encrypt_query_param: downloadEncryptedQueryParam,
        aes_key: aesKeyBase64,
        encrypt_type: 1,
      };

      let item: Record<string, unknown>;
      switch (mediaType) {
        case 1:
          item = { type: 2, image_item: { media: cdnMedia, mid_size: fileSizeCiphertext } };
          break;
        case 2:
          item = { type: 5, video_item: { media: cdnMedia, video_size: fileSizeCiphertext } };
          break;
        case 4:
          item = { type: 3, voice_item: { media: cdnMedia } };
          break;
        default:
          item = { type: 4, file_item: { media: cdnMedia, file_name: fileName, len: String(bytes.length) } };
          break;
      }

      await apiPost<Record<string, unknown>>('/ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [item],
          context_token: contextToken,
        },
      }, session.botToken, session.baseUrl);

      console.info('[ilink] sendfile sent', { to, name: fileName, mediaType, byteLength: bytes.length });
    },

    async downloadMedia({ cdnUrl, aesKey, mimeType, name }) {
      const response = await fetchIlink(new URL(cdnUrl), {}, '/ilink/cdn/download');
      if (!response.ok) throw new Error(`ilink media download failed ${response.status}`);
      const encrypted = Buffer.from(await response.arrayBuffer());
      const key = Buffer.from(aesKey, 'base64');
      if (key.length !== 16) throw new Error('ilink media aes key length invalid');
      return { bytes: decryptAes128Ecb(encrypted, key), mimeType, name };
    },
  };
}
