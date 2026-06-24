export type PiAppCustomSkillActivation = {
  keywords?: string[];
  regex?: string;
  explicitOnly?: boolean;
};

export type PiAppCustomSkillResource = {
  path?: string;
  content?: string;
};

export type PiAppCustomSkill = {
  name?: string;
  description?: string;
  content?: string;
  enabled?: boolean;
  activation?: PiAppCustomSkillActivation;
  toolGroups?: string[];
  resources?: PiAppCustomSkillResource[];
  disableModelInvocation?: boolean;
};

export type PiAppAccessMode = 'all' | 'admins' | 'users' | 'rbac';
export type PiAppThinkingLevel = 'off' | 'low' | 'medium' | 'high';
export type PiAppThinkingFormat = 'openai' | 'qwen' | 'qwen-chat-template';

export type PiAppJsonData = {
  openAIBaseUrl?: string;
  defaultModel?: string;
  thinkingLevel?: PiAppThinkingLevel;
  thinkingFormat?: PiAppThinkingFormat;
  isOpenAIAPIKeySet?: boolean;
  accessMode?: PiAppAccessMode;
  allowedUsers?: string[];
  allowedPrometheusDatasourceUids?: string[];
  // Legacy name kept for existing plugin settings.
  allowedDatasourceUids?: string[];
  systemPromptAddendum?: string;
  customSkills?: PiAppCustomSkill[];
};
