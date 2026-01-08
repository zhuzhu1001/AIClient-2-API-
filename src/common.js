import { promises as fs } from 'fs';
import * as path from 'path';
import * as http from 'http'; // Add http for IncomingMessage and ServerResponse types
import * as crypto from 'crypto'; // Import crypto for MD5 hashing
import { convertData, getOpenAIStreamChunkStop } from './convert.js';
import { ProviderStrategyFactory } from './provider-strategies.js';

// ==================== 网络错误处理 ====================

/**
 * 可重试的网络错误标识列表
 * 这些错误可能出现在 error.code 或 error.message 中
 */
export const RETRYABLE_NETWORK_ERRORS = [
    'ECONNRESET',      // 连接被重置
    'ETIMEDOUT',       // 连接超时
    'ECONNREFUSED',    // 连接被拒绝
    'ENOTFOUND',       // DNS 解析失败
    'ENETUNREACH',     // 网络不可达
    'EHOSTUNREACH',    // 主机不可达
    'EPIPE',           // 管道破裂
    'EAI_AGAIN',       // DNS 临时失败
    'ECONNABORTED',    // 连接中止
    'ESOCKETTIMEDOUT', // Socket 超时
];

/**
 * 检查是否为可重试的网络错误
 * @param {Error} error - 错误对象
 * @returns {boolean} - 是否为可重试的网络错误
 */
export function isRetryableNetworkError(error) {
    if (!error) return false;

    const errorCode = error.code || '';
    const errorMessage = error.message || '';

    return RETRYABLE_NETWORK_ERRORS.some(errId =>
        errorCode === errId || errorMessage.includes(errId)
    );
}

/**
 * 识别需要立即标记不健康并换账户重试的错误
 * 包括：429 Rate Limit、额度耗尽、容量不足
 * @param {Error} error - 错误对象
 * @returns {boolean} - 是否为需要换账户重试的错误
 */
export function isCapacityExhaustedError(error) {
    if (!error) return false;

    const message = (error.message || '').toLowerCase();
    const statusCode = extractHttpStatusCode(error);

    // HTTP 429 Rate Limit
    if (statusCode === 429) {
        return true;
    }

    // 额度耗尽相关消息
    const exhaustedPatterns = [
        'exhausted your capacity',
        'no capacity available',
        'quota exceeded',
        'rate limit exceeded',
        'too many requests',
        'resource exhausted',
        'rate_limit_error'
    ];

    return exhaustedPatterns.some(pattern => message.includes(pattern));
}

/**
 * 识别不可重试的错误（如空请求体、无效请求）
 * 这些错误不应该重试，直接返回给客户端
 * @param {Error} error - 错误对象
 * @returns {boolean} - 是否为不可重试的错误
 */
export function isNonRetryableError(error) {
    if (!error) return false;

    const message = (error.message || '').toLowerCase();

    const nonRetryablePatterns = [
        'contents field is required',
        'request body is missing',
        'invalid json',
        'invalid request',
        'invalid_request_error',
        'authentication_error',
        'permission_denied'
    ];

    return nonRetryablePatterns.some(pattern => message.includes(pattern));
}

// ==================== API 常量 ====================

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};

export const MODEL_PROTOCOL_PREFIX = {
    // Model provider constants
    GEMINI: 'gemini',
    OPENAI: 'openai',
    OPENAI_RESPONSES: 'openaiResponses',
    CLAUDE: 'claude',
    OLLAMA: 'ollama',
}

export const MODEL_PROVIDER = {
    // Model provider constants
    GEMINI_CLI: 'gemini-cli-oauth',
    ANTIGRAVITY: 'gemini-antigravity',
    OPENAI_CUSTOM: 'openai-custom',
    OPENAI_CUSTOM_RESPONSES: 'openaiResponses-custom',
    CLAUDE_CUSTOM: 'claude-custom',
    KIRO_API: 'claude-kiro-oauth',
    QWEN_API: 'openai-qwen-oauth',
    IFLOW_API: 'openai-iflow',
}

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol (e.g., gemini, openai, claude).
 * @param {string} provider - The model provider string (e.g., 'gemini-cli', 'openai-custom').
 * @returns {string} The protocol prefix (e.g., 'gemini', 'openai', 'claude').
 */
export function getProtocolPrefix(provider) {
    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) {
        return provider.substring(0, hyphenIndex);
    }
    return provider; // Return original if no hyphen is found
}

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai_chat',
    OPENAI_RESPONSES: 'openai_responses',
    GEMINI_CONTENT: 'gemini_content',
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
    GEMINI_MODEL_LIST: 'gemini_model_list',
};

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'fetch_system_prompt.txt');
export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/**
 * Reads the entire request body from an HTTP request.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @returns {Promise<Object>} A promise that resolves with the parsed JSON request body.
 * @throws {Error} If the request body is not valid JSON.
 */
export function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            if (!body) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Invalid JSON in request body."));
            }
        });
        req.on('error', err => {
            reject(err);
        });
    });
}

export async function logConversation(type, content, logMode, logFilename) {
    if (logMode === 'none') return;
    if (!content) return;

    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;

    if (logMode === 'console') {
        console.log(logEntry);
    } else if (logMode === 'file') {
        try {
            // Append to the file
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            console.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
        }
    }
}

/**
 * Checks if the request is authorized based on API key.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {URL} requestUrl - The parsed URL object.
 * @param {string} REQUIRED_API_KEY - The API key required for authorization.
 * @returns {boolean} True if authorized, false otherwise.
 */
export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key']; // Claude-specific header

    // Check for Bearer token in Authorization header (OpenAI style)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === REQUIRED_API_KEY) {
            return true;
        }
    }

    // Check for API key in URL query parameter (Gemini style)
    if (queryKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-goog-api-key header (Gemini style)
    if (googApiKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-api-key header (Claude style)
    if (claudeApiKey === REQUIRED_API_KEY) {
        return true;
    }

    console.log(`[Auth] Unauthorized request denied. Bearer: "${authHeader ? 'present' : 'N/A'}", Query Key: "${queryKey}", x-goog-api-key: "${googApiKey}", x-api-key: "${claudeApiKey}"`);
    return false;
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 * This includes writing response headers, logging conversation, and logging auth token expiry.
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {Object} responsePayload - The actual response payload (string for unary, object for stream chunks).
 * @param {boolean} isStream - Whether the response is a stream.
 */
export async function handleUnifiedResponse(res, responsePayload, isStream) {
    if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Transfer-Encoding": "chunked" });
    } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
    }

    if (isStream) {
        // Stream chunks are handled by the calling function that iterates the stream
    } else {
        res.end(responsePayload);
    }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName) {
    let fullResponseText = '';
    let fullResponseJson = '';
    let fullOldResponseJson = '';
    let responseClosed = false;
    let headersSent = false;

    // 延迟发送 header，等到第一个数据块到达或确认流正常开始后再发送
    // 这样如果 generateContentStream 抛出错误，可以返回正确的 HTTP 状态码
    const sendHeadersIfNeeded = () => {
        if (!headersSent && !res.headersSent) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Transfer-Encoding": "chunked"
            });
            headersSent = true;
        }
    };

    // fs.writeFile('request'+Date.now()+'.json', JSON.stringify(requestBody));
    // The service returns a stream in its native format (toProvider).
    const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
    requestBody.model = model;

    // 流创建阶段：如果失败，向上抛出异常以支持重试机制
    // 此时 header 还未发送，上层可以捕获异常并尝试换账户重试
    const nativeStream = await service.generateContentStream(model, requestBody);

    const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    const openStop = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI ;

    try {
        for await (const nativeChunk of nativeStream) {
            // 收到第一个数据块时发送 header
            sendHeadersIfNeeded();
            // Extract text for logging purposes
            const chunkText = extractResponseText(nativeChunk, toProvider);
            if (chunkText && !Array.isArray(chunkText)) {
                fullResponseText += chunkText;
            }

            // Convert the complete chunk object to the client's format (fromProvider), if necessary.
            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model)
                : nativeChunk;

            if (!chunkToSend) {
                continue;
            }

            // 处理 chunkToSend 可能是数组或对象的情况
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                if (addEvent) {
                    // fullOldResponseJson += chunk.type+"\n";
                    // fullResponseJson += chunk.type+"\n";
                    res.write(`event: ${chunk.type}\n`);
                    // console.log(`event: ${chunk.type}\n`);
                }

                // fullOldResponseJson += JSON.stringify(chunk)+"\n";
                // fullResponseJson += JSON.stringify(chunk)+"\n\n";
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                // console.log(`data: ${JSON.stringify(chunk)}\n`);
            }
        }
        // 确保在发送结束标记前 header 已发送（处理零 chunk 场景）
        sendHeadersIfNeeded();

        if (openStop && needsConversion) {
            res.write(`data: ${JSON.stringify(getOpenAIStreamChunkStop(model))}\n\n`);
            // console.log(`data: ${JSON.stringify(getOpenAIStreamChunkStop(model))}\n`);
        }

        // 流式请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            const customNameDisplay = customName ? `, ${customName}` : '';
            console.log(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful stream request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }

    }  catch (error) {
        console.error('\n[Server] Error during stream processing:', error.stack);
        if (providerPoolManager && pooluuid) {
            console.log(`[Provider Pool] Marking ${toProvider} as unhealthy due to stream error`);
            // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            }, error.message);
        }

        // 流式请求：如果 header 还没发送，设置正确的 HTTP 状态码
        if (!res.headersSent) {
            const statusCode = extractHttpStatusCode(error);
            res.writeHead(statusCode, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            });
        }
        // 使用新方法创建符合 fromProvider 格式的流式错误响应
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        res.write(errorPayload);
        res.end();
        responseClosed = true;
    } finally {
        if (!responseClosed) {
            res.end();
        }
        await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        // fs.writeFile('oldResponseChunk'+Date.now()+'.json', fullOldResponseJson);
        // fs.writeFile('responseChunk'+Date.now()+'.json', fullResponseJson);
    }
}


export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName) {
    // 移除 try-catch，让错误向上传播以支持重试机制
    // The service returns the response in its native format (toProvider).
    const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
    requestBody.model = model;
    // fs.writeFile('oldRequest'+Date.now()+'.json', JSON.stringify(requestBody));
    const nativeResponse = await service.generateContent(model, requestBody);
    const responseText = extractResponseText(nativeResponse, toProvider);

    // Convert the response back to the client's format (fromProvider), if necessary.
    let clientResponse = nativeResponse;
    if (needsConversion) {
        console.log(`[Response Convert] Converting response from ${toProvider} to ${fromProvider}`);
        clientResponse = convertData(nativeResponse, 'response', toProvider, fromProvider, model);
    }

    //console.log(`[Response] Sending response to client: ${JSON.stringify(clientResponse)}`);
    await handleUnifiedResponse(res, JSON.stringify(clientResponse), false);
    await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    // fs.writeFile('oldResponse'+Date.now()+'.json', JSON.stringify(clientResponse));

    // 一元请求成功完成，统计使用次数，错误次数重置为0
    if (providerPoolManager && pooluuid) {
        const customNameDisplay = customName ? `, ${customName}` : '';
        console.log(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful unary request`);
        providerPoolManager.markProviderHealthy(toProvider, {
            uuid: pooluuid
        });
    }
}

/**
 * Handles requests for listing available models. It fetches models from the
 * service, transforms them to the format expected by the client (OpenAI, Claude, etc.),
 * and sends the JSON response.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_MODEL_LIST).
 * @param {Object} CONFIG - The server configuration object.
 */
export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid) {
    // toProvider 需要在 try 外定义，catch 中也要用
    const toProvider = CONFIG.MODEL_PROVIDER;

    try{
        const clientProviderMap = {
            [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
            [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI,
        };

        const fromProvider = clientProviderMap[endpointType];

        if (!fromProvider) {
            throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
        }

        // 1. Get the model list in the backend's native format.
        const nativeModelList = await service.listModels();
                
        // 2. Convert the model list to the client's expected format, if necessary.
        let clientModelList = nativeModelList;
        if (!getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider))) {
            console.log(`[ModelList Convert] Converting model list from ${toProvider} to ${fromProvider}`);
            clientModelList = convertData(nativeModelList, 'modelList', toProvider, fromProvider);
        } else {
            console.log(`[ModelList Convert] Model list format matches. No conversion needed.`);
        }

        console.log(`[ModelList Response] Sending model list to client: ${JSON.stringify(clientModelList)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientModelList));
    } catch (error) {
        console.error('\n[Server] Error during model list processing:', error.stack);
        if (providerPoolManager && pooluuid) {
            // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            }, error.message);
        }
        // 使用 handleErrorResponse 返回协议一致的错误响应
        const clientProviderMap = {
            [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
            [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI,
        };
        const fromProvider = clientProviderMap[endpointType] || MODEL_PROTOCOL_PREFIX.OPENAI;
        await handleErrorResponse(res, error, fromProvider, false);
    }
}

/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the internal Gemini format,
 * logging, and dispatching to the appropriate stream or unary handler.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_CHAT).
 * @param {Object} CONFIG - The server configuration object.
 * @param {string} PROMPT_LOG_FILENAME - The prompt log filename.
 */
export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    const MAX_RETRY_COUNT = 3; // 最大重试次数（换账户重试）

    const originalRequestBody = await getRequestBody(req);

    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
        [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];

    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // ========== 请求体有效性检查（不可重试错误，直接返回） ==========
    // 检查 originalRequestBody 是否为合法对象
    if (!originalRequestBody || typeof originalRequestBody !== 'object') {
        const error = new Error('Unable to submit request because at least one contents field is required.');
        error.statusCode = 400;
        await handleErrorResponse(res, error, fromProvider, false);
        return;
    }

    // 检查是否包含必要的内容字段
    const hasContents = originalRequestBody.contents?.length > 0;
    const hasMessages = originalRequestBody.messages?.length > 0;
    const hasInput = originalRequestBody.input?.length > 0;

    if (!hasContents && !hasMessages && !hasInput) {
        const error = new Error('Unable to submit request because at least one contents field is required.');
        error.statusCode = 400;
        await handleErrorResponse(res, error, fromProvider, false);
        return;
    }

    // 使用实际的提供商类型（可能是 fallback 后的类型）
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;

    // 2. Extract model and determine if the request is for streaming.
    let { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }
    console.log(`[Content Generation] Model: ${model}, Stream: ${isStream}`);

    let actualCustomName = CONFIG.customName;
    let currentService = service;

    // 2.5. 始终使用 getApiServiceWithFallback 选择支持该模型的账号
    // 这确保了模型级筛选和 fallback 链的正确工作
    if (providerPoolManager && CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]) {
        const { getApiServiceWithFallback } = await import('./service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model);

        currentService = result.service;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;
        actualCustomName = result.serviceConfig?.customName || CONFIG.customName;

        // 如果发生了模型级别的 fallback，需要更新请求使用的模型
        if (result.actualModel && result.actualModel !== model) {
            console.log(`[Content Generation] Model Fallback: ${model} -> ${result.actualModel}`);
            model = result.actualModel;
        }

        if (result.isFallback) {
            console.log(`[Content Generation] Fallback activated: ${CONFIG.MODEL_PROVIDER} -> ${toProvider} (uuid: ${actualUuid})`);
        } else {
            console.log(`[Content Generation] Selected provider for model ${model}: ${toProvider} (uuid: ${actualUuid})`);
        }
    }

    // ========== 带重试的请求处理 ==========
    let retryCount = 0;
    let lastError = null;

    while (retryCount < MAX_RETRY_COUNT) {
        try {
            // 1. 深拷贝原始请求体，避免 _applySystemPromptFromFile/_manageSystemPrompt 重复修改
            // 使用 structuredClone 保留 Uint8Array、Date 等非 JSON 类型（支持多模态输入）
            let processedRequestBody = structuredClone(originalRequestBody);

            // 2. Convert request body from client format to backend format, if necessary.
            if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)) {
                console.log(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
                processedRequestBody = convertData(processedRequestBody, 'request', fromProvider, toProvider);
            } else {
                console.log(`[Request Convert] Request format matches backend provider. No conversion needed.`);
            }

            // 3. Apply system prompt from file if configured.
            processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
            await _manageSystemPrompt(processedRequestBody, toProvider);

            // 4. Log the incoming prompt (after potential conversion to the backend's format).
            const promptText = extractPromptText(processedRequestBody, toProvider);
            await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

            // 5. Call the appropriate stream or unary handler, passing the provider info.
            if (isStream) {
                await handleStreamRequest(res, currentService, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName);
            } else {
                await handleUnaryRequest(res, currentService, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName);
            }

            // 请求成功，直接返回
            return;

        } catch (error) {
            lastError = error;

            // 检查是否为不可重试错误（如无效请求、认证错误等）
            if (isNonRetryableError(error)) {
                console.log(`[Retry] Non-retryable error, returning immediately: ${error.message}`);
                // 不可重试错误也需要标记账号不健康（如 401/403 认证错误）
                if (providerPoolManager && actualUuid) {
                    providerPoolManager.markProviderUnhealthy(toProvider, { uuid: actualUuid }, error.message);
                }
                await handleErrorResponse(res, error, fromProvider, isStream);
                return;
            }

            // 检查是否为需要换账户重试的错误（429、额度耗尽等）
            if (isCapacityExhaustedError(error) && providerPoolManager) {
                retryCount++;
                console.log(`[Retry] Capacity exhausted error detected, attempt ${retryCount}/${MAX_RETRY_COUNT}: ${error.message}`);

                // 立即标记当前账户为不健康
                if (actualUuid) {
                    providerPoolManager.markProviderUnhealthyImmediately(
                        toProvider,
                        { uuid: actualUuid },
                        error.message
                    );
                }

                if (retryCount < MAX_RETRY_COUNT) {
                    // 尝试获取新账户
                    try {
                        const { getApiServiceWithFallback } = await import('./service-manager.js');
                        const result = await getApiServiceWithFallback(CONFIG, model);

                        currentService = result.service;
                        actualUuid = result.uuid;
                        toProvider = result.actualProviderType;
                        actualCustomName = result.serviceConfig?.customName;

                        // 如果发生了模型级别的 fallback，需要更新请求使用的模型
                        if (result.actualModel && result.actualModel !== model) {
                            console.log(`[Retry] Model Fallback: ${model} -> ${result.actualModel}`);
                            model = result.actualModel;
                        }

                        console.log(`[Retry] Switched to new account: ${actualUuid} (${toProvider})`);
                        continue; // 继续重试
                    } catch (selectError) {
                        // 无法获取新账户，返回 503
                        console.log(`[Retry] No healthy account available: ${selectError.message}`);
                        const serviceUnavailableError = new Error('Service temporarily unavailable. All providers are exhausted.');
                        serviceUnavailableError.statusCode = 503;
                        await handleErrorResponse(res, serviceUnavailableError, fromProvider, isStream);
                        return;
                    }
                }
            } else {
                // 其他错误（如 500 服务器错误），标记账号不健康但不重试
                console.log(`[Retry] Other error type, marking unhealthy and returning: ${error.message}`);
                if (providerPoolManager && actualUuid) {
                    providerPoolManager.markProviderUnhealthy(toProvider, { uuid: actualUuid }, error.message);
                }
                await handleErrorResponse(res, error, fromProvider, isStream);
                return;
            }
        }
    }

    // 所有重试都失败，返回 503
    console.log(`[Retry] All ${retryCount} retry attempts failed`);
    const serviceUnavailableError = new Error('Service temporarily unavailable. All providers are exhausted.');
    serviceUnavailableError.statusCode = 503;
    await handleErrorResponse(res, serviceUnavailableError, fromProvider, isStream);
}

/**
 * Helper function to extract model and stream information from the request.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {Object} requestBody The parsed request body.
 * @param {string} fromProvider The type of endpoint being called.
 * @returns {{model: string, isStream: boolean}} An object containing the model name and stream status.
 */
function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

async function _applySystemPromptFromFile(config, requestBody, toProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(toProvider));
    return strategy.applySystemPromptFromFile(config, requestBody);
}

export async function _manageSystemPrompt(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    await strategy.manageSystemPrompt(requestBody);
}

// Helper functions for content extraction and conversion (from convert.js, but needed here)
export function extractResponseText(response, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractPromptText(requestBody);
}

export function handleError(res, error, provider = null) {
    const statusCode = extractHttpStatusCode(error);
    let errorMessage = error.message;
    let suggestions = [];

    // 仅在没有传入错误信息时，才使用默认消息；否则只添加建议
    const hasOriginalMessage = error.message && error.message.trim() !== '';

    // 根据提供商获取适配的错误信息和建议
    const providerSuggestions = _getProviderSpecificSuggestions(statusCode, provider);
    
    // Provide detailed information and suggestions for different error types
    switch (statusCode) {
        case 401:
            errorMessage = 'Authentication failed. Please check your credentials.';
            suggestions = providerSuggestions.auth;
            break;
        case 403:
            errorMessage = 'Access forbidden. Insufficient permissions.';
            suggestions = providerSuggestions.permission;
            break;
        case 429:
            errorMessage = 'Too many requests. Rate limit exceeded.';
            suggestions = providerSuggestions.rateLimit;
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            errorMessage = 'Server error occurred. This is usually temporary.';
            suggestions = providerSuggestions.serverError;
            break;
        default:
            if (statusCode >= 400 && statusCode < 500) {
                errorMessage = `Client error (${statusCode}): ${error.message}`;
                suggestions = providerSuggestions.clientError;
            } else if (statusCode >= 500) {
                errorMessage = `Server error (${statusCode}): ${error.message}`;
                suggestions = providerSuggestions.serverError;
            }
    }

    errorMessage = hasOriginalMessage ? error.message.trim() : errorMessage;
    console.error(`\n[Server] Request failed (${statusCode}): ${errorMessage}`);
    if (suggestions.length > 0) {
        console.error('[Server] Suggestions:');
        suggestions.forEach((suggestion, index) => {
            console.error(`  ${index + 1}. ${suggestion}`);
        });
    }
    console.error('[Server] Full error details:', error.stack);

    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    }

    const errorPayload = {
        error: {
            message: errorMessage,
            code: statusCode,
            suggestions: suggestions,
            details: error.response?.data
        }
    };
    res.end(JSON.stringify(errorPayload));
}

/**
 * 根据提供商类型获取适配的错误建议
 * @param {number} statusCode - HTTP 状态码
 * @param {string|null} provider - 提供商类型
 * @returns {Object} 包含各类错误建议的对象
 */
function _getProviderSpecificSuggestions(statusCode, provider) {
    const protocolPrefix = provider ? getProtocolPrefix(provider) : null;
    
    // 默认/通用建议
    const defaultSuggestions = {
        auth: [
            'Verify your API key or credentials are valid',
            'Check if your credentials have expired',
            'Ensure the API key has the necessary permissions'
        ],
        permission: [
            'Check if your account has the necessary permissions',
            'Verify the API endpoint is accessible with your credentials',
            'Contact your administrator if permissions are restricted'
        ],
        rateLimit: [
            'The request has been automatically retried with exponential backoff',
            'If the issue persists, try reducing the request frequency',
            'Consider upgrading your API quota if available'
        ],
        serverError: [
            'The request has been automatically retried',
            'If the issue persists, try again in a few minutes',
            'Check the service status page for outages'
        ],
        clientError: [
            'Check your request format and parameters',
            'Verify the model name is correct',
            'Ensure all required fields are provided'
        ]
    };
    
    // 根据提供商返回特定建议
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            return {
                auth: [
                    'Verify your OAuth credentials are valid',
                    'Try re-authenticating by deleting the credentials file',
                    'Check if your Google Cloud project has the necessary permissions'
                ],
                permission: [
                    'Ensure your Google Cloud project has the Gemini API enabled',
                    'Check if your account has the necessary permissions',
                    'Verify the project ID is correct'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Google Cloud API quota'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Google Cloud status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Gemini model',
                    'Ensure all required fields are provided'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.OPENAI:
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            return {
                auth: [
                    'Verify your OpenAI API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the API key is correctly formatted (starts with sk-)'
                ],
                permission: [
                    'Check if your OpenAI account has access to the requested model',
                    'Verify your organization settings allow this operation',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your OpenAI usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check OpenAI status page (status.openai.com) for outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid OpenAI model',
                    'Ensure the message format is correct (role and content fields)'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            return {
                auth: [
                    'Verify your Anthropic API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the x-api-key header is correctly set'
                ],
                permission: [
                    'Check if your Anthropic account has access to the requested model',
                    'Verify your account is in good standing',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Anthropic usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Anthropic status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Claude model',
                    'Ensure the message format follows Anthropic API specifications'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.OLLAMA:
            return {
                auth: [
                    'Ollama typically does not require authentication',
                    'If using a custom setup, verify your credentials',
                    'Check if the Ollama server requires authentication'
                ],
                permission: [
                    'Verify the Ollama server is accessible',
                    'Check if the requested model is available locally',
                    'Ensure the Ollama server allows the requested operation'
                ],
                rateLimit: [
                    'The local Ollama server may be overloaded',
                    'Try reducing concurrent requests',
                    'Consider increasing server resources if running locally'
                ],
                serverError: [
                    'Check if the Ollama server is running',
                    'Verify the server address and port are correct',
                    'Check Ollama server logs for detailed error information'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is available in your Ollama installation',
                    'Try pulling the model first with: ollama pull <model-name>'
                ]
            };
            
        default:
            return defaultSuggestions;
    }
}

/**
 * 从请求体中提取系统提示词。
 * @param {Object} requestBody - 请求体对象。
 * @param {string} provider - 提供商类型（'openai', 'gemini', 'claude'）。
 * @returns {string} 提取到的系统提示词字符串。
 */
export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            const openaiSystemMessage = requestBody.messages?.find(m => m.role === 'system');
            if (openaiSystemMessage?.content) {
                incomingSystemText = openaiSystemMessage.content;
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system message
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    incomingSystemText = userMessage.content;
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
            if (geminiSystemInstruction?.parts) {
                incomingSystemText = geminiSystemInstruction.parts
                    .filter(p => p?.text)
                    .map(p => p.text)
                    .join('\n');
            } else if (requestBody.contents?.length > 0) {
                // Fallback to first user content if no system instruction
                const userContent = requestBody.contents[0];
                if (userContent?.parts) {
                    incomingSystemText = userContent.parts
                        .filter(p => p?.text)
                        .map(p => p.text)
                        .join('\n');
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system property
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    if (Array.isArray(userMessage.content)) {
                        incomingSystemText = userMessage.content.map(block => block.text).join('');
                    } else {
                        incomingSystemText = userMessage.content;
                    }
                }
            }
            break;
        default:
            console.warn(`[System Prompt] Unknown provider: ${provider}`);
            break;
    }
    return incomingSystemText;
}

/**
 * Generates an MD5 hash for a given object by first converting it to a JSON string.
 * @param {object} obj - The object to hash.
 * @returns {string} The MD5 hash of the object's JSON string representation.
 */
export function getMD5Hash(obj) {
    const jsonString = JSON.stringify(obj);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}

/**
 * 从 error 对象中提取有效的 HTTP 状态码
 * 确保返回的是有效的数字状态码 (100-599)，否则回退到 500
 * @param {Error} error - 错误对象
 * @returns {number} 有效的 HTTP 状态码
 */
export function extractHttpStatusCode(error) {
    // 按优先级检查各种可能的状态码来源
    const candidates = [
        error.response?.status,     // Axios 响应状态码
        error.statusCode,           // 自定义 statusCode
        error.status,               // 标准 status
    ];

    for (const candidate of candidates) {
        // 确保是数字且在有效范围内 (100-599)
        if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) {
            return candidate;
        }
    }

    // error.code 可能是字符串如 'ECONNRESET'，不能用于 HTTP 状态码
    // 回退到 500
    return 500;
}


/**
 * 创建符合 fromProvider 格式的错误响应（非流式）
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {Object} 格式化的错误响应对象
 */
function createErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const statusCode = extractHttpStatusCode(error);
    const errorMessage = error.message || "An error occurred during processing.";
    
    // 根据 HTTP 状态码映射错误类型
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };
    
    // 根据 HTTP 状态码映射 Gemini 的 status
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };
    
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 非流式错误格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)  // OpenAI 使用 code 字段作为核心判断
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API 非流式错误格式
            return {
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 非流式错误格式（外层有 type 标记）
            return {
                type: "error",  // 核心区分标记
                error: {
                    type: getErrorType(statusCode),  // Claude 使用 error.type 作为核心判断
                    message: errorMessage
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini 非流式错误格式（遵循 Google Cloud 标准）
            return {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)  // Gemini 使用 status 作为核心判断
                }
            };
            
        default:
            // 默认使用 OpenAI 格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)
                }
            };
    }
}

/**
 * 创建符合 fromProvider 格式的流式错误响应
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {string} 格式化的流式错误响应字符串
 */
function createStreamErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const statusCode = extractHttpStatusCode(error);
    const errorMessage = error.message || "An error occurred during streaming.";
    
    // 根据 HTTP 状态码映射错误类型
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };
    
    // 根据 HTTP 状态码映射 Gemini 的 status
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };
    
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 流式错误格式（SSE data 块）
            const openaiError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(openaiError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API 流式错误格式（SSE event + data）
            const responsesError = {
                id: `resp_${Date.now()}`,
                object: "error",
                created: Math.floor(Date.now() / 1000),
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            return `event: error\ndata: ${JSON.stringify(responsesError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 流式错误格式（SSE event + data）
            const claudeError = {
                type: "error",
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage
                }
            };
            return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini 流式错误格式
            // 注意：虽然 Gemini 原生使用 JSON 数组，但在我们的实现中已经转换为 SSE 格式
            // 所以这里也需要使用 data: 前缀，保持与正常流式响应一致
            const geminiError = {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)
                }
            };
            return `data: ${JSON.stringify(geminiError)}\n\n`;
            
        default:
            // 默认使用 OpenAI SSE 格式
            const defaultError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(defaultError)}\n\n`;
    }
}

/**
 * 处理错误响应，返回正确的 HTTP 状态码
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @param {boolean} isStream - 是否是流式请求
 */
export async function handleErrorResponse(res, error, fromProvider, isStream = false) {
    // 从 error 对象提取正确的状态码（确保是有效的数字状态码）
    const statusCode = extractHttpStatusCode(error);

    if (isStream) {
        // 流式错误响应
        if (!res.headersSent) {
            res.writeHead(statusCode, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            });
        }
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        res.write(errorPayload);
        res.end();
    } else {
        // 非流式错误响应
        const errorResponse = createErrorResponse(error, fromProvider);
        if (!res.headersSent) {
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify(errorResponse));
    }
}
