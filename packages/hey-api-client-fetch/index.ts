type ArrayStyle = "form" | "spaceDelimited" | "pipeDelimited";
type ObjectStyle = "form" | "deepObject";
type QuerySerializer = (query: Record<string, unknown>) => string;
type BodySerializer = (body: unknown) => BodyInit | null | undefined;
type HttpMethod =
  | "CONNECT"
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT"
  | "TRACE";

export interface SerializerOptions<T> {
  explode: boolean;
  style: T;
}

export interface QuerySerializerOptions {
  allowReserved?: boolean;
  array?: SerializerOptions<ArrayStyle>;
  object?: SerializerOptions<ObjectStyle>;
}

export type ErrInterceptor<Err, Res, Req, Options> = (
  error: Err,
  response: Res,
  request: Req,
  options: Options,
) => Err | Promise<Err>;

export type ReqInterceptor<Req, Options> = (request: Req, options: Options) => Req | Promise<Req>;

export type ResInterceptor<Res, Req, Options> = (
  response: Res,
  request: Req,
  options: Options,
) => Res | Promise<Res>;

class Interceptors<Interceptor> {
  _fns: Interceptor[] = [];

  clear(): void {
    this._fns = [];
  }

  exists(fn: Interceptor): boolean {
    return this._fns.includes(fn);
  }

  eject(fn: Interceptor): void {
    this._fns = this._fns.filter((candidate) => candidate !== fn);
  }

  use(fn: Interceptor): void {
    this._fns = [...this._fns, fn];
  }
}

export interface Middleware<Req, Res, Err, Options> {
  error: Pick<Interceptors<ErrInterceptor<Err, Res, Req, Options>>, "eject" | "use">;
  request: Pick<Interceptors<ReqInterceptor<Req, Options>>, "eject" | "use">;
  response: Pick<Interceptors<ResInterceptor<Res, Req, Options>>, "eject" | "use">;
}

function appendSerializedValue(
  target: FormData | URLSearchParams,
  name: string,
  value: unknown,
): void {
  if (target instanceof FormData) {
    const normalized =
      typeof value === "string" || value instanceof Blob ? value : JSON.stringify(value);
    target.append(name, normalized);
    return;
  }

  target.append(name, typeof value === "string" ? value : JSON.stringify(value));
}

export const formDataBodySerializer = {
  bodySerializer(body: unknown): FormData {
    const formData = new FormData();
    if (!body || typeof body !== "object") {
      return formData;
    }
    for (const [name, value] of Object.entries(body)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) appendSerializedValue(formData, name, item);
        continue;
      }
      appendSerializedValue(formData, name, value);
    }
    return formData;
  },
};

export const jsonBodySerializer = {
  bodySerializer<T>(body: T): string {
    return JSON.stringify(body);
  },
};

export const urlSearchParamsBodySerializer = {
  bodySerializer<T extends Record<string, unknown> | Array<Record<string, unknown>>>(
    body: T,
  ): URLSearchParams {
    const searchParams = new URLSearchParams();
    for (const [name, value] of Object.entries(body)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) appendSerializedValue(searchParams, name, item);
        continue;
      }
      appendSerializedValue(searchParams, name, value);
    }
    return searchParams;
  },
};

type PrimitiveHeaderValue = string | number | boolean;
type HeaderValue = PrimitiveHeaderValue | PrimitiveHeaderValue[] | null | undefined | unknown;

type OmitKeys<T, K> = Pick<T, Exclude<keyof T, K>>;

export interface Config<ThrowOnError extends boolean = boolean>
  extends Omit<RequestInit, "body" | "headers" | "method"> {
  baseUrl?: string;
  body?:
    | RequestInit["body"]
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | Array<unknown>
    | number;
  bodySerializer?: BodySerializer;
  fetch?: typeof fetch;
  headers?: RequestInit["headers"] | Record<string, HeaderValue>;
  method?: HttpMethod;
  parseAs?: Exclude<keyof Body, "body" | "bodyUsed"> | "auto" | "stream";
  querySerializer?: QuerySerializer | QuerySerializerOptions;
  responseTransformer?: (data: unknown) => Promise<unknown> | unknown;
  throwOnError?: ThrowOnError;
}

export interface RequestOptionsBase<ThrowOnError extends boolean> extends Config<ThrowOnError> {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  url: string;
}

export type RequestResult<
  Data = unknown,
  TError = unknown,
  ThrowOnError extends boolean = boolean,
> = ThrowOnError extends true
  ? Promise<{
      data: Data;
      request: Request;
      response: Response;
    }>
  : Promise<
      (
        | {
            data: Data;
            error: undefined;
          }
        | {
            data: undefined;
            error: TError;
          }
      ) & {
        request: Request;
        response: Response;
      }
    >;

type MethodFn = <Data = unknown, TError = unknown, ThrowOnError extends boolean = false>(
  options: Omit<RequestOptionsBase<ThrowOnError>, "method">,
) => RequestResult<Data, TError, ThrowOnError>;

type RequestFn = <Data = unknown, TError = unknown, ThrowOnError extends boolean = false>(
  options: Omit<RequestOptionsBase<ThrowOnError>, "method"> &
    Pick<Required<RequestOptionsBase<ThrowOnError>>, "method">,
) => RequestResult<Data, TError, ThrowOnError>;

type InternalRequestOptions = RequestOptionsBase<boolean> &
  Config<boolean> & {
    headers: Headers;
  };

export interface Client<
  Req = Request,
  Res = Response,
  Err = unknown,
  Options = InternalRequestOptions,
> {
  connect: MethodFn;
  delete: MethodFn;
  get: MethodFn;
  getConfig: () => Config;
  head: MethodFn;
  interceptors: Middleware<Req, Res, Err, Options>;
  options: MethodFn;
  patch: MethodFn;
  post: MethodFn;
  put: MethodFn;
  request: RequestFn;
  setConfig: (config: Config) => Config;
  trace: MethodFn;
}

type OptionsBase<ThrowOnError extends boolean> = Omit<RequestOptionsBase<ThrowOnError>, "url"> & {
  client?: Client;
};

export type Options<T = unknown, ThrowOnError extends boolean = boolean> = T extends {
  body?: infer _Body;
}
  ? T extends { headers?: infer _Headers }
    ? OmitKeys<OptionsBase<ThrowOnError>, "body" | "headers"> & T
    : OmitKeys<OptionsBase<ThrowOnError>, "body"> & T & Pick<OptionsBase<ThrowOnError>, "headers">
  : T extends { headers?: infer _Headers }
    ? OmitKeys<OptionsBase<ThrowOnError>, "headers"> & T & Pick<OptionsBase<ThrowOnError>, "body">
    : OptionsBase<ThrowOnError> & T;

const PATH_PARAM_PATTERN = /\{[^{}]+\}/g;

function serializePrimitive({
  allowReserved,
  name,
  value,
}: {
  allowReserved?: boolean;
  name: string;
  value: unknown;
}): string {
  if (value == null) return "";
  if (typeof value === "object") {
    throw new Error(
      "Deeply-nested arrays/objects aren't supported. Provide your own `querySerializer()` to handle these.",
    );
  }
  return `${name}=${allowReserved ? value : encodeURIComponent(String(value))}`;
}

function getArraySeparator(style: ArrayStyle): string {
  switch (style) {
    case "spaceDelimited":
      return "%20";
    case "pipeDelimited":
      return "|";
    default:
      return ",";
  }
}

function getStylePrefix(style: "form" | "label" | "matrix" | "simple" | ArrayStyle): string {
  switch (style) {
    case "label":
      return ".";
    case "matrix":
      return ";";
    case "simple":
      return ",";
    default:
      return "&";
  }
}

function serializeArray({
  allowReserved,
  explode,
  name,
  style,
  value,
}: {
  allowReserved?: boolean;
  explode: boolean;
  name: string;
  style: "form" | "label" | "matrix" | "simple" | ArrayStyle;
  value: unknown[];
}): string {
  if (!explode) {
    const joined = value
      .map((entry) => (allowReserved ? String(entry) : encodeURIComponent(String(entry))))
      .join(
        getArraySeparator(
          style === "simple" || style === "label" || style === "matrix" ? "form" : style,
        ),
      );
    switch (style) {
      case "label":
        return `.${joined}`;
      case "matrix":
        return `;${name}=${joined}`;
      case "simple":
        return joined;
      default:
        return `${name}=${joined}`;
    }
  }

  const delimiter = getStylePrefix(style);
  const rendered = value
    .map((entry) => {
      if (style === "label" || style === "simple") {
        return allowReserved ? String(entry) : encodeURIComponent(String(entry));
      }
      return serializePrimitive({ allowReserved, name, value: entry });
    })
    .join(delimiter);
  return style === "label" || style === "matrix" ? `${delimiter}${rendered}` : rendered;
}

function serializeObject({
  allowReserved,
  explode,
  name,
  style,
  value,
}: {
  allowReserved?: boolean;
  explode: boolean;
  name: string;
  style: "form" | "label" | "matrix" | "simple" | "deepObject";
  value: Record<string, unknown>;
}): string {
  if (value instanceof Date) return `${name}=${value.toISOString()}`;

  if (style !== "deepObject" && !explode) {
    const entries: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
      entries.push(key, allowReserved ? String(entry) : encodeURIComponent(String(entry)));
    }
    const joined = entries.join(",");
    switch (style) {
      case "form":
        return `${name}=${joined}`;
      case "label":
        return `.${joined}`;
      case "matrix":
        return `;${name}=${joined}`;
      default:
        return joined;
    }
  }

  const delimiter = getStylePrefix(style === "deepObject" ? "form" : style);
  const rendered = Object.entries(value)
    .map(([key, entry]) =>
      serializePrimitive({
        allowReserved,
        name: style === "deepObject" ? `${name}[${key}]` : key,
        value: entry,
      }),
    )
    .join(delimiter);
  return style === "label" || style === "matrix" ? `${delimiter}${rendered}` : rendered;
}

function buildPath({ path, url }: { path?: Record<string, unknown>; url: string }): string {
  let result = url;
  const matches = url.match(PATH_PARAM_PATTERN);
  if (!matches || !path) return result;

  for (const rawMatch of matches) {
    let explode = false;
    let name = rawMatch.slice(1, -1);
    let style: "form" | "label" | "matrix" | "simple" = "simple";

    if (name.endsWith("*")) {
      explode = true;
      name = name.slice(0, -1);
    }
    if (name.startsWith(".")) {
      name = name.slice(1);
      style = "label";
    } else if (name.startsWith(";")) {
      name = name.slice(1);
      style = "matrix";
    }

    const value = path[name];
    if (value == null) continue;

    if (Array.isArray(value)) {
      result = result.replace(rawMatch, serializeArray({ explode, name, style, value }));
      continue;
    }
    if (typeof value === "object") {
      result = result.replace(
        rawMatch,
        serializeObject({ explode, name, style, value: value as Record<string, unknown> }),
      );
      continue;
    }
    if (style === "matrix") {
      result = result.replace(rawMatch, `;${serializePrimitive({ name, value })}`);
      continue;
    }
    const encoded =
      style === "label"
        ? `.${encodeURIComponent(String(value))}`
        : encodeURIComponent(String(value));
    result = result.replace(rawMatch, encoded);
  }

  return result;
}

function createQuerySerializer(options: QuerySerializerOptions = {}): QuerySerializer {
  return (query) => {
    const parts: string[] = [];

    if (query && typeof query === "object") {
      for (const [name, value] of Object.entries(query)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          parts.push(
            serializeArray({
              allowReserved: options.allowReserved,
              explode: true,
              name,
              style: "form",
              value,
              ...options.array,
            }),
          );
          continue;
        }
        if (typeof value === "object") {
          parts.push(
            serializeObject({
              allowReserved: options.allowReserved,
              explode: true,
              name,
              style: "deepObject",
              value: value as Record<string, unknown>,
              ...options.object,
            }),
          );
          continue;
        }
        parts.push(serializePrimitive({ allowReserved: options.allowReserved, name, value }));
      }
    }

    return parts.join("&");
  };
}

function getParserForContentType(
  contentType: string | null,
): Exclude<Config["parseAs"], "auto" | "stream" | undefined> | undefined {
  if (!contentType) return undefined;
  const normalized = contentType.split(";")[0]?.trim();
  if (!normalized) return undefined;
  if (normalized.startsWith("application/json") || normalized.endsWith("+json")) return "json";
  if (normalized === "multipart/form-data") return "formData";
  if (
    normalized.startsWith("application/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("image/") ||
    normalized.startsWith("video/")
  ) {
    return "blob";
  }
  if (normalized.startsWith("text/")) return "text";
  return undefined;
}

function buildUrl(options: {
  baseUrl: string;
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  querySerializer: QuerySerializer;
  url: string;
}): string {
  const isAbsoluteUrl = /^https?:\/\//i.test(options.url);
  const normalizedUrl = options.url.startsWith("/") ? options.url : `/${options.url}`;
  let url = isAbsoluteUrl ? options.url : `${options.baseUrl}${normalizedUrl}`;
  if (options.path) url = buildPath({ path: options.path, url });
  const queryString = options.query ? options.querySerializer(options.query) : "";
  if (queryString.length > 0) {
    const normalizedQuery = queryString.startsWith("?") ? queryString.slice(1) : queryString;
    url += `${url.includes("?") ? "&" : "?"}${normalizedQuery}`;
  }
  return url;
}

function mergeHeaders(
  ...headerSets: Array<RequestInit["headers"] | Record<string, HeaderValue> | undefined>
): Headers {
  const headers = new Headers();

  for (const headerSet of headerSets) {
    if (!headerSet || typeof headerSet !== "object") continue;
    const entries: Array<[string, HeaderValue]> = [];
    if (headerSet instanceof Headers) {
      headerSet.forEach((value, name) => {
        entries.push([name, value]);
      });
    } else {
      entries.push(...Object.entries(headerSet));
    }

    for (const [name, value] of entries) {
      if (value === null) {
        headers.delete(name);
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) headers.append(name, String(entry));
        continue;
      }
      if (value !== undefined) {
        headers.set(name, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
  }

  return headers;
}

function mergeConfigs(base: Config, override: Config): Config {
  const merged: Config = { ...base, ...override };
  if (merged.baseUrl?.endsWith("/")) {
    merged.baseUrl = merged.baseUrl.slice(0, -1);
  }
  merged.headers = mergeHeaders(base.headers, override.headers);
  return merged;
}

const DEFAULT_QUERY_SERIALIZER = createQuerySerializer({
  allowReserved: false,
  array: { explode: true, style: "form" },
  object: { explode: true, style: "deepObject" },
});

const DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

export function createConfig(override: Config = {}): Config {
  return {
    ...jsonBodySerializer,
    baseUrl: "",
    fetch: globalThis.fetch,
    headers: DEFAULT_HEADERS,
    parseAs: "auto",
    querySerializer: DEFAULT_QUERY_SERIALIZER,
    ...override,
  };
}

function createMiddleware(): Middleware<Request, Response, unknown, InternalRequestOptions> {
  return {
    error: new Interceptors<ErrInterceptor<unknown, Response, Request, InternalRequestOptions>>(),
    request: new Interceptors<ReqInterceptor<Request, InternalRequestOptions>>(),
    response: new Interceptors<ResInterceptor<Response, Request, InternalRequestOptions>>(),
  };
}

export function createClient(config: Config = {}): Client {
  let currentConfig = mergeConfigs(createConfig(), config);

  const getConfig = (): Config => ({ ...currentConfig });

  const setConfig = (nextConfig: Config): Config => {
    currentConfig = mergeConfigs(currentConfig, nextConfig);
    return getConfig();
  };

  const interceptors = createMiddleware();

  const request = (async <Data = unknown, TError = unknown, ThrowOnError extends boolean = false>(
    options: Omit<RequestOptionsBase<ThrowOnError>, "method"> &
      Pick<Required<RequestOptionsBase<ThrowOnError>>, "method">,
  ) => {
    const resolvedOptions: InternalRequestOptions = {
      ...currentConfig,
      ...options,
      fetch: options.fetch ?? currentConfig.fetch ?? globalThis.fetch,
      headers: mergeHeaders(currentConfig.headers, options.headers),
    };

    if (resolvedOptions.body && resolvedOptions.bodySerializer) {
      resolvedOptions.body = resolvedOptions.bodySerializer(resolvedOptions.body);
    }

    if (!resolvedOptions.body) {
      resolvedOptions.headers.delete("Content-Type");
    } else if (resolvedOptions.body instanceof FormData) {
      resolvedOptions.headers.delete("Content-Type");
    }

    const url = buildUrl({
      baseUrl: resolvedOptions.baseUrl ?? "",
      path: resolvedOptions.path,
      query: resolvedOptions.query,
      querySerializer:
        typeof resolvedOptions.querySerializer === "function"
          ? resolvedOptions.querySerializer
          : createQuerySerializer(resolvedOptions.querySerializer),
      url: resolvedOptions.url,
    });

    const requestInit: RequestInit = {
      redirect: "follow",
      ...resolvedOptions,
      body: resolvedOptions.body as BodyInit | null | undefined,
    };

    let requestInstance = new Request(url, requestInit);
    for (const interceptor of (
      interceptors.request as Interceptors<ReqInterceptor<Request, InternalRequestOptions>>
    )._fns) {
      requestInstance = await interceptor(requestInstance, resolvedOptions);
    }

    const fetchImpl = resolvedOptions.fetch ?? globalThis.fetch;
    let response = await fetchImpl(requestInstance);

    for (const interceptor of (
      interceptors.response as Interceptors<
        ResInterceptor<Response, Request, InternalRequestOptions>
      >
    )._fns) {
      response = await interceptor(response, requestInstance, resolvedOptions);
    }

    const result = { request: requestInstance, response };

    if (response.ok) {
      if (response.status === 204 || response.headers.get("Content-Length") === "0") {
        return {
          data: {} as Data,
          ...result,
        };
      }

      if (resolvedOptions.parseAs === "stream") {
        return {
          data: response.body as Data,
          ...result,
        };
      }

      const parser =
        (resolvedOptions.parseAs === "auto"
          ? getParserForContentType(response.headers.get("Content-Type"))
          : resolvedOptions.parseAs) ?? "json";
      let data = (await response[parser]()) as unknown;
      if (parser === "json" && resolvedOptions.responseTransformer) {
        data = await resolvedOptions.responseTransformer(data);
      }

      return {
        data: data as Data,
        ...result,
      };
    }

    const text = await response.text();
    let error: unknown = text;
    try {
      error = JSON.parse(text);
    } catch {
      // Leave the textual response as-is.
    }

    for (const interceptor of (
      interceptors.error as Interceptors<
        ErrInterceptor<unknown, Response, Request, InternalRequestOptions>
      >
    )._fns) {
      error = await interceptor(error, response, requestInstance, resolvedOptions);
    }

    error ||= {};

    if (resolvedOptions.throwOnError) {
      throw error;
    }

    return {
      data: undefined,
      error: error as TError,
      ...result,
    };
  }) as RequestFn;

  const withMethod =
    (method: HttpMethod): MethodFn =>
    (options) =>
      request({
        ...options,
        method,
      });

  return {
    connect: withMethod("CONNECT"),
    delete: withMethod("DELETE"),
    get: withMethod("GET"),
    getConfig,
    head: withMethod("HEAD"),
    interceptors,
    options: withMethod("OPTIONS"),
    patch: withMethod("PATCH"),
    post: withMethod("POST"),
    put: withMethod("PUT"),
    request,
    setConfig,
    trace: withMethod("TRACE"),
  };
}
