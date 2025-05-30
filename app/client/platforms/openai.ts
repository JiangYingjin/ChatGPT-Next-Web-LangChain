"use client";
// azure and openai, using same models. so using same LLMApi.
import {
  ApiPath,
  DEFAULT_MODELS,
  OpenaiPath,
  Azure,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
  OPENAI_BASE_URL,
} from "@/app/constant";
import {
  ChatMessageTool,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "@/app/store";
import { collectModelsWithDefaultModel } from "@/app/utils/model";
import {
  preProcessImageAndWebReferenceContent,
  streamWithThink,
} from "@/app/utils/chat";
import { cloudflareAIGatewayUrl } from "@/app/utils/cloudflare";
import {
  DalleSize,
  DalleQuality,
  DalleStyle,
  GPTImageSize,
  GPTImageQuality,
  GPTImageBackground,
} from "@/app/typing";

import {
  AgentChatOptions,
  ChatOptions,
  CreateRAGStoreOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  LLMUsage,
  MultimodalContent,
  SpeechOptions,
  TranscriptionOptions,
} from "../api";
import Locale from "../../locales";
import {
  EventStreamContentType,
  fetchEventSource,
} from "@fortaine/fetch-event-source";
import { prettyObject } from "@/app/utils/format";
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent,
  isVisionModel,
  isOpenAIImageGenerationModel,
  getWebReferenceMessageTextContent,
  getTimeoutMSByModel,
  isGPTImageModel,
  isDalle3,
} from "@/app/utils";

export interface OpenAIListModelResponse {
  object: string;
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
}

export interface RequestPayload {
  messages: {
    role: "system" | "user" | "assistant";
    content: string | MultimodalContent[];
  }[];
  stream?: boolean;
  model: string;
  temperature: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_p: number;
  max_tokens?: number;
  max_completion_tokens?: number;
}

export interface DalleRequestPayload {
  model: string;
  prompt: string;
  response_format: "url" | "b64_json";
  n: number;
  size: DalleSize;
  quality: DalleQuality;
  style?: DalleStyle;
}

export interface GPTImageRequestPayload {
  model: string;
  prompt: string;
  response_format: "url" | "b64_json";
  n: number;
  size: GPTImageSize;
  quality: GPTImageQuality;
  background?: GPTImageBackground;
}

export class ChatGPTApi implements LLMApi {
  private disableListModels = false;

  path(path: string, model?: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    const isAzure = path.includes("deployments");
    if (accessStore.useCustomConfig) {
      if (isAzure && !accessStore.isValidAzure()) {
        throw Error(
          "incomplete azure config, please check it in your settings page",
        );
      }

      baseUrl = isAzure ? accessStore.azureUrl : accessStore.openaiUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = isAzure ? ApiPath.Azure : ApiPath.OpenAI;
      baseUrl = isApp ? OPENAI_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (
      !baseUrl.startsWith("http") &&
      !isAzure &&
      !baseUrl.startsWith(ApiPath.OpenAI)
    ) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    // try rebuild url, when using cloudflare ai gateway in client
    return cloudflareAIGatewayUrl([baseUrl, path].join("/"));
  }

  extractMessage(res: any) {
    return res.choices?.at(0)?.message?.content ?? "";
  }

  async speech(options: SpeechOptions): Promise<ArrayBuffer> {
    const requestPayload = {
      model: options.model,
      input: options.input,
      voice: options.voice,
      response_format: options.response_format,
      speed: options.speed,
    };

    console.log("[Request] openai speech payload: ", requestPayload);

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const speechPath = this.path(OpenaiPath.SpeechPath, options.model);
      const speechPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const res = await fetch(speechPath, speechPayload);
      clearTimeout(requestTimeoutId);
      return await res.arrayBuffer();
    } catch (e) {
      console.log("[Request] failed to make a speech request", e);
      throw e;
    }
  }

  async transcription(options: TranscriptionOptions): Promise<string> {
    const formData = new FormData();
    formData.append("file", options.file, "audio.wav");
    formData.append("model", options.model ?? "whisper-1");
    if (options.language) formData.append("language", options.language);
    if (options.prompt) formData.append("prompt", options.prompt);
    if (options.response_format)
      formData.append("response_format", options.response_format);
    if (options.temperature)
      formData.append("temperature", options.temperature.toString());

    console.log("[Request] openai audio transcriptions payload: ", options);

    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const path = this.path(OpenaiPath.TranscriptionPath, options.model);
      const headers = getHeaders(true);
      const payload = {
        method: "POST",
        body: formData,
        signal: controller.signal,
        headers: headers,
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      const res = await fetch(path, payload);
      clearTimeout(requestTimeoutId);
      const json = await res.json();
      return json.text;
    } catch (e) {
      console.log("[Request] failed to make a audio transcriptions request", e);
      throw e;
    }
  }

  async chat(options: ChatOptions) {
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };

    let requestPayload:
      | RequestPayload
      | DalleRequestPayload
      | GPTImageRequestPayload;

    const isImageGenModel = isOpenAIImageGenerationModel(options.config.model);
    const isOseries =
      options.config.model.startsWith("o1") ||
      options.config.model.startsWith("o3") ||
      options.config.model.startsWith("o4");

    if (isImageGenModel) {
      const prompt = getMessageTextContent(
        options.messages.slice(-1)?.pop() as any,
      );
      if (isGPTImageModel(options.config.model)) {
        requestPayload = {
          model: options.config.model,
          prompt,
          // URLs are only valid for 60 minutes after the image has been generated.
          response_format: "b64_json", // using b64_json, and save image in CacheStorage
          n: 1,
          size: options.config?.size ?? "auto",
          quality: options.config?.quality ?? "auto",
        } as GPTImageRequestPayload;
      } else {
        requestPayload = {
          model: options.config.model,
          prompt,
          // URLs are only valid for 60 minutes after the image has been generated.
          response_format: "b64_json", // using b64_json, and save image in CacheStorage
          n: 1,
          size: options.config?.size ?? "1024x1024",
          quality: options.config?.quality ?? "standard",
          style: options.config?.style ?? "vivid",
        } as DalleRequestPayload;
      }
    } else {
      const visionModel = isVisionModel(options.config.model);
      const messages: ChatOptions["messages"] = [];
      for (const v of options.messages) {
        const content = visionModel
          ? await preProcessImageAndWebReferenceContent(v)
          : getWebReferenceMessageTextContent(v);
        if (!(isOseries && v.role === "system"))
          messages.push({ role: v.role, content });
      }

      // O1 support image, tools (except o4-mini for now) and system, stream, *NOT* logprobs, temperature, top_p, n, presence_penalty, frequency_penalty yet.
      requestPayload = {
        messages,
        stream: options.config.stream,
        model: modelConfig.model,
        temperature: !isOseries ? modelConfig.temperature : 1,
        presence_penalty: !isOseries ? modelConfig.presence_penalty : 0,
        frequency_penalty: !isOseries ? modelConfig.frequency_penalty : 0,
        top_p: !isOseries ? modelConfig.top_p : 1,
        // max_tokens: Math.max(modelConfig.max_tokens, 1024),
        // Please do not ask me why not send max_tokens, no reason, this param is just shit, I dont want to explain anymore.
      };

      // add max_tokens to vision model
      // O系列 使用 max_completion_tokens 控制token数 (https://platform.openai.com/docs/guides/reasoning#controlling-costs)
      if (visionModel) {
        if (isOseries) {
          requestPayload["max_completion_tokens"] = 23456;
        } else {
          requestPayload["max_tokens"] = Math.max(modelConfig.max_tokens, 4000);
        }
      }
    }

    console.log("[Request] openai payload: ", requestPayload);

    const shouldStream = !isImageGenModel && !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      let chatPath = "";
      if (modelConfig.providerName === ServiceProvider.Azure) {
        // find model, and get displayName as deployName
        const { models: configModels, customModels: configCustomModels } =
          useAppConfig.getState();
        const {
          defaultModel,
          customModels: accessCustomModels,
          useCustomConfig,
        } = useAccessStore.getState();
        const models = collectModelsWithDefaultModel(
          configModels,
          [configCustomModels, accessCustomModels].join(","),
          defaultModel,
        );
        const model = models.find(
          (model) =>
            model.name === modelConfig.model &&
            model?.provider?.providerName === ServiceProvider.Azure,
        );
        chatPath = this.path(
          (isImageGenModel ? Azure.ImagePath : Azure.ChatPath)(
            (model?.displayName ?? model?.name) as string,
            useCustomConfig ? useAccessStore.getState().azureApiVersion : "",
          ),
        );
      } else {
        chatPath = this.path(
          isImageGenModel ? OpenaiPath.ImagePath : OpenaiPath.ChatPath,
        );
      }
      if (shouldStream) {
        let index = -1;
        // const [tools, funcs] = usePluginStore
        //   .getState()
        //   .getAsTools(
        //     useChatStore.getState().currentSession().mask?.plugin || [],
        //   );
        const tools = null;
        const funcs: Record<string, Function> = {};
        // console.log("getAsTools", tools, funcs);
        streamWithThink(
          chatPath,
          requestPayload,
          getHeaders(),
          tools as any,
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            // console.log("parseSSE", text, runTools);
            const json = JSON.parse(text);
            const choices = json.choices as Array<{
              delta: {
                content: string;
                tool_calls: ChatMessageTool[];
                reasoning_content: string | null;
                reasoning: string | null;
              };
            }>;

            if (!choices?.length) return { isThinking: false, content: "" };

            const tool_calls = choices[0]?.delta?.tool_calls;
            if (tool_calls?.length > 0) {
              const id = tool_calls[0]?.id;
              const args = tool_calls[0]?.function?.arguments;
              if (id) {
                index += 1;
                runTools.push({
                  id,
                  type: tool_calls[0]?.type,
                  function: {
                    name: tool_calls[0]?.function?.name as string,
                    arguments: args,
                  },
                });
              } else {
                // @ts-ignore
                runTools[index]["function"]["arguments"] += args;
              }
            }

            const reasoning =
              choices[0]?.delta?.reasoning_content ||
              choices[0]?.delta?.reasoning;
            const content = choices[0]?.delta?.content;

            // Skip if both content and reasoning_content are empty or null
            if (
              (!reasoning || reasoning.length === 0) &&
              (!content || content.length === 0)
            ) {
              return {
                isThinking: false,
                content: "",
              };
            }

            if (reasoning && reasoning.length > 0) {
              return {
                isThinking: true,
                content: reasoning,
              };
            } else if (content && content.length > 0) {
              return {
                isThinking: false,
                content: content,
              };
            }

            return {
              isThinking: false,
              content: "",
            };
          },
          // processToolMessage, include tool_calls message and tool call results
          (
            requestPayload: RequestPayload,
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            // reset index value
            index = -1;
            // @ts-ignore
            requestPayload?.messages?.splice(
              // @ts-ignore
              requestPayload?.messages?.length,
              0,
              toolCallMessage,
              ...toolCallResult,
            );
          },
          options,
        );
      } else {
        const chatPayload = {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: getHeaders(),
        };

        // make a fetch request
        const requestTimeoutId = setTimeout(
          () => controller.abort(),
          getTimeoutMSByModel(options.config.model),
        );

        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = await this.extractMessage(resJson);
        options.onFinish(message, res);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  async createRAGStore(options: CreateRAGStoreOptions): Promise<string> {
    try {
      const accessStore = useAccessStore.getState();
      const isAzure = accessStore.provider === ServiceProvider.Azure;
      let baseUrl = isAzure ? accessStore.azureUrl : accessStore.openaiUrl;
      const requestPayload = {
        sessionId: options.chatSessionId,
        fileInfos: options.fileInfos,
        baseUrl: baseUrl,
      };
      console.log("[Request] rag store payload: ", requestPayload);
      const controller = new AbortController();
      options.onController?.(controller);
      let path = "/api/langchain/rag/store";
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };
      const res = await fetch(path, chatPayload);
      if (res.status !== 200) throw new Error(await res.text());
      const resJson = await res.json();
      return resJson.partial;
    } catch (e) {
      console.log("[Request] failed to make a chat reqeust", e);
      options.onError?.(e as Error);
      return "";
    }
  }

  async toolAgentChat(options: AgentChatOptions) {
    const visionModel = isVisionModel(options.config.model);
    const messages: AgentChatOptions["messages"] = [];
    for (const v of options.messages) {
      const content = visionModel
        ? await preProcessImageAndWebReferenceContent(v)
        : getMessageTextContent(v);
      messages.push({ role: v.role, content });
    }

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
      },
    };
    const accessStore = useAccessStore.getState();
    const isAzure = accessStore.provider === ServiceProvider.Azure;
    let baseUrl = isAzure ? accessStore.azureUrl : accessStore.openaiUrl;
    const requestPayload = {
      chatSessionId: options.chatSessionId,
      messages,
      isAzure,
      azureApiVersion: accessStore.azureApiVersion,
      stream: options.config.stream,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      presence_penalty: modelConfig.presence_penalty,
      frequency_penalty: modelConfig.frequency_penalty,
      top_p: modelConfig.top_p,
      baseUrl: baseUrl,
      maxIterations: options.agentConfig.maxIterations,
      returnIntermediateSteps: options.agentConfig.returnIntermediateSteps,
      useTools: options.agentConfig.useTools,
      provider: ServiceProvider.OpenAI,
    };

    console.log("[Request] openai payload: ", requestPayload);

    const shouldStream = true;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      let path = "/api/langchain/tool/agent/";
      const enableNodeJSPlugin = !!process.env.NEXT_PUBLIC_ENABLE_NODEJS_PLUGIN;
      path = enableNodeJSPlugin ? path + "nodejs" : path + "edge";
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      // console.log("shouldStream", shouldStream);

      if (shouldStream) {
        let responseText = "";
        let finished = false;

        const finish = () => {
          if (!finished) {
            options.onFinish(responseText);
            finished = true;
          }
        };

        controller.signal.onabort = finish;

        fetchEventSource(path, {
          ...chatPayload,
          async onopen(res) {
            clearTimeout(requestTimeoutId);
            const contentType = res.headers.get("content-type");
            console.log(
              "[OpenAI] request response content type: ",
              contentType,
            );

            if (contentType?.startsWith("text/plain")) {
              responseText = await res.clone().text();
              return finish();
            }

            if (
              !res.ok ||
              !res.headers
                .get("content-type")
                ?.startsWith(EventStreamContentType) ||
              res.status !== 200
            ) {
              const responseTexts = [responseText];
              let extraInfo = await res.clone().text();
              console.warn(`extraInfo: ${extraInfo}`);
              // try {
              //   const resJson = await res.clone().json();
              //   extraInfo = prettyObject(resJson);
              // } catch { }

              if (res.status === 401) {
                responseTexts.push(Locale.Error.Unauthorized);
              }

              if (extraInfo) {
                responseTexts.push(extraInfo);
              }

              responseText = responseTexts.join("\n\n");

              return finish();
            }
          },
          onmessage(msg) {
            let response = JSON.parse(msg.data);
            if (!response.isSuccess) {
              console.error("[Request]", msg.data);
              responseText = msg.data;
              throw Error(response.message);
            }
            if (msg.data === "[DONE]" || finished) {
              return finish();
            }
            try {
              if (response && !response.isToolMessage) {
                responseText += response.message;
                options.onUpdate?.(responseText, response.message);
              } else {
                options.onToolUpdate?.(response.toolName!, response.message);
              }
            } catch (e) {
              console.error("[Request] parse error", response, msg);
            }
          },
          onclose() {
            finish();
          },
          onerror(e) {
            options.onError?.(e);
            throw e;
          },
          openWhenHidden: true,
        });
      } else {
        const res = await fetch(path, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat reqeust", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
        .getDate()
        .toString()
        .padStart(2, "0")}`;
    const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startDate = formatDate(startOfMonth);
    const endDate = formatDate(new Date(Date.now() + ONE_DAY));

    const [used, subs] = await Promise.all([
      fetch(
        this.path(
          `${OpenaiPath.UsagePath}?start_date=${startDate}&end_date=${endDate}`,
        ),
        {
          method: "GET",
          headers: getHeaders(),
        },
      ),
      fetch(this.path(OpenaiPath.SubsPath), {
        method: "GET",
        headers: getHeaders(),
      }),
    ]);

    if (used.status === 401) {
      throw new Error(Locale.Error.Unauthorized);
    }

    if (!used.ok || !subs.ok) {
      throw new Error("Failed to query usage from openai");
    }

    const response = (await used.json()) as {
      total_usage?: number;
      error?: {
        type: string;
        message: string;
      };
    };

    const total = (await subs.json()) as {
      hard_limit_usd?: number;
    };

    if (response.error && response.error.type) {
      throw Error(response.error.message);
    }

    if (response.total_usage) {
      response.total_usage = Math.round(response.total_usage) / 100;
    }

    if (total.hard_limit_usd) {
      total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
    }

    return {
      used: response.total_usage,
      total: total.hard_limit_usd,
    } as LLMUsage;
  }

  async models(): Promise<LLMModel[]> {
    const accessStore = useAccessStore.getState();
    if (!accessStore.isUseRemoteModels) {
      return DEFAULT_MODELS.slice();
    }

    const res = await fetch(this.path(OpenaiPath.ListModelPath), {
      method: "GET",
      headers: {
        ...getHeaders(),
      },
    });

    const resJson = (await res.json()) as OpenAIListModelResponse;
    // const chatModels = resJson.data?.filter(
    //   (m) => m.id.startsWith("gpt-") || m.id.startsWith("chatgpt-"),
    // );
    const chatModels = resJson.data.sort((a, b) => {
      return b.created - a.created;
    });
    console.log("[Models]", chatModels);

    if (!chatModels) {
      return [];
    }

    let seq = 1000; //同 Constant.ts 中的排序保持一致
    return chatModels.map((m) => ({
      name: m.id,
      available: true,
      sorted: seq++,
      provider: {
        id: m.owned_by.toLowerCase(),
        providerName: m.owned_by,
        providerType: m.owned_by.toLowerCase(),
        sorted: 1,
      },
    }));
  }
}
export { OpenaiPath };
