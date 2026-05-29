export type PiAppJsonData = {
  openAIBaseUrl?: string;
  defaultModel?: string;
  isOpenAIAPIKeySet?: boolean;
  allowedDatasourceUids?: string[];
  systemPromptAddendum?: string;
};
