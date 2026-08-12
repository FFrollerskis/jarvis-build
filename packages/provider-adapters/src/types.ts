export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  system?: string;
  messages: ChatMessage[];
  max_tokens?: number;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ModelResult {
  text: string;
  usage: ModelUsage;
  provider: string;
  model: string;
}

/**
 * Felles adaptergrensesnitt for alle modell-leverandører (arkitekturregel:
 * ingen modul snakker med en leverandør-API direkte, kun via adapter).
 * onToken muliggjør streaming; adaptere uten ekte streaming kaller den én gang.
 */
export interface ModelProviderAdapter {
  readonly name: string;
  /** Har adapteren nødvendig konfigurasjon (nøkkel/endepunkt) til å kunne brukes? */
  available(): boolean;
  complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult>;
}
