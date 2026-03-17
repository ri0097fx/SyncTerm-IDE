from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class WatcherModel(BaseModel):
  id: str
  displayName: str
  lastHeartbeat: float


class SessionModel(BaseModel):
  name: str
  watcherId: str


class CreateSessionModel(BaseModel):
  name: str


class WatcherStatusModel(BaseModel):
  user: str
  host: str
  cwd: str
  fullCwd: str
  condaEnv: Optional[str] = None
  dockerMode: Optional[str] = None


class FileEntryModel(BaseModel):
  id: str
  name: str
  path: str
  kind: str
  hasChildren: Optional[bool] = False
  isRemoteLink: Optional[bool] = False
  children: Optional[List["FileEntryModel"]] = None


FileEntryModel.model_rebuild()


class RunnerConfigModel(BaseModel):
  mode: str
  containerName: Optional[str] = None
  image: Optional[str] = None
  mountPath: Optional[str] = None
  extraArgs: Optional[str] = None


class LogChunk(BaseModel):
  lines: List[str]
  nextOffset: int
  hasMore: bool


class CommandPayload(BaseModel):
  command: str


class FileContentPayload(BaseModel):
  path: str
  content: str


class FileChunkModel(BaseModel):
  path: str
  offset: int
  length: int
  totalSize: int
  content: str
  hasMore: bool
  nextOffset: int


class RunnerConfigUpdatePayload(BaseModel):
  mode: str
  containerName: Optional[str] = None
  image: Optional[str] = None
  mountPath: Optional[str] = None
  extraArgs: Optional[str] = None


class CreateLinkPayload(BaseModel):
  sourcePath: str
  linkName: str


class CreatePathPayload(BaseModel):
  path: str
  kind: str  # "file" | "dir"


class DeletePathPayload(BaseModel):
  path: str


class CopyPathPayload(BaseModel):
  sourcePath: str
  destPath: str


class MovePathPayload(BaseModel):
  sourcePath: str
  destPath: str


class UploadFilePayload(BaseModel):
  path: str
  contentBase64: str


class ChatMessage(BaseModel):
  role: str  # "user" | "assistant"
  content: str


class AiAssistPayload(BaseModel):
  path: str
  action: str
  prompt: str
  selectedText: Optional[str] = None
  fileContent: str
  history: Optional[List[ChatMessage]] = None
  model: Optional[str] = None
  mode: Optional[str] = None  # agent | plan | debug | ask
  # Agent 用: エディタの現在のコンテキスト（コード直接変更・推論に利用）
  editorPath: Optional[str] = None
  editorSelectedText: Optional[str] = None
  editorContent: Optional[str] = None
  # 思考レベル: quick | balanced | deep
  thinking: Optional[str] = None
  # ユーザー定義ペルソナ／追加指示（システムプロンプト先頭に付与）
  persona: Optional[str] = None
  # フロントからのハイブリッドルーティング有効化フラグ（Auto モデル時のみ使用）
  hybridRouting: Optional[bool] = None


class AiInlinePayload(BaseModel):
  path: str
  prefix: str
  suffix: str
  language: Optional[str] = None
  model: Optional[str] = None


class AiEnsureModelPayload(BaseModel):
  model: str


class AgentCommandLog(BaseModel):
  command: str
  exitCode: Optional[int] = None
  output: str = ""
  error: Optional[str] = None


class DebateTurn(BaseModel):
  round: int
  speaker: str          # "agent" | "moderator" など人間可読ラベル
  model: str            # 使用したモデル名（qwen3.5:9b など）
  role: str             # "assistant" 固定（chat history 互換のため）
  content: str


class DebateThread(BaseModel):
  id: str
  title: Optional[str] = None
  models: List[str]
  turns: List[DebateTurn] = Field(default_factory=list)


class AiAssistResponse(BaseModel):
  result: str
  command: Optional[str] = None
  needsApproval: bool = False
  # モデルがトークン上限で打ち切られたかどうか（OpenAI / Ollama の finish_reason / done_reason ベース）
  truncated: bool = False
  # 自動で "Continue." を送って続きを連結した場合に True
  autoContinued: bool = False
  # Agent モードで実行したコマンドと出力のログ（デバッグタブ用）
  logs: List[AgentCommandLog] = Field(default_factory=list)
  # 複数モデルでのディベート結果（フロントで可視化用）
  debates: List[DebateThread] = Field(default_factory=list)


class BuddyFeedbackPayload(BaseModel):
  message: str
  role: str = "assistant"
  rating: str  # "good" | "bad"
  taskType: Optional[str] = None
  mode: Optional[str] = None
  thinking: Optional[str] = None
  model: Optional[str] = None
  watcherId: Optional[str] = None
  session: Optional[str] = None

