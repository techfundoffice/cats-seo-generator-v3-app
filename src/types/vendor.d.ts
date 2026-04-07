declare module 'json-repair-js' {
  export function repairJson(json: string, options?: { returnObjects?: boolean }): string | object;
}

declare module 'seord' {
  export class SeoCheck {
    constructor(content: any, domain?: string);
    analyzeSeo(): Promise<any>;
    getReport(): any;
  }
}

declare module 'harper.js' {
  export class LocalLinter {
    constructor(options: { binary: Uint8Array | ArrayBuffer; dialect?: number });
    setup(): Promise<void>;
    lint(text: string): Promise<{ message: string; span: { start: number; end: number } }[]>;
  }
  export const binary: Uint8Array | ArrayBuffer;
  export const Dialect: { American: number; British: number; [key: string]: number } | undefined;
}

declare module '@anthropic-ai/claude-agent-sdk' {
  interface QueryOptions {
    prompt: string;
    options?: {
      systemPrompt?: string;
      allowedTools?: string[];
      maxTurns?: number;
      permissionMode?: string;
      allowDangerouslySkipPermissions?: boolean;
      model?: string;
      cwd?: string;
    };
  }
  interface QueryMessage {
    type: string;
    subtype?: string;
    result: string;
    is_error?: boolean;
  }
  export function query(options: QueryOptions): AsyncIterable<QueryMessage>;
}

declare module 'sharp' {
  interface Sharp {
    resize(width?: number | null, height?: number | null, options?: object): Sharp;
    png(options?: object): Sharp;
    jpeg(options?: object): Sharp;
    webp(options?: object): Sharp;
    toBuffer(): Promise<Buffer>;
    toFile(path: string): Promise<object>;
  }
  function sharp(input?: Buffer | string | Uint8Array, options?: object): Sharp;
  export = sharp;
}
