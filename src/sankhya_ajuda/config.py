"""Application configuration loaded from environment variables.

All secrets use ``SecretStr`` so they never appear in logs or ``repr``.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class PgSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PG_", env_file=".env", extra="ignore")

    host: str = "localhost"
    port: int = 5433
    db: str = "sankhya_ajuda"
    user: str = "sankhya_ajuda"
    password: SecretStr = SecretStr("")

    @property
    def dsn(self) -> str:
        return (
            f"postgresql://{self.user}:{self.password.get_secret_value()}"
            f"@{self.host}:{self.port}/{self.db}"
        )


class VllmSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VLLM_", env_file=".env", extra="ignore")

    # No hardcoded default URL. Set VLLM_BASE_URL in .env. Empty string is
    # tolerated so deployments that do not use vLLM (e.g. OpenAI-only) can omit
    # it; callers should validate presence before invoking the embedding client.
    base_url: str = ""
    api_key: SecretStr = SecretStr("")
    model: str = "/model"
    dimensions: int = 2560
    timeout: float = 60.0


class ZendeskSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SANKHYA_HC_", env_file=".env", extra="ignore")

    base: str = "https://ajuda.sankhya.com.br"
    locale: str = "pt-br"
    per_page: int = 100
    delay: float = 0.3
    user_agent: str = "sankhya_ajuda-mcp/0.1"


class BettermodeSettings(BaseSettings):
    """Community source (community.sankhya.com.br runs on Bettermode/GraphQL).

    The GraphQL endpoint issues a read-only *guest* token to anonymous callers
    via the ``tokens(networkDomain: ...)`` query, so no API key is required —
    that token is fetched and refreshed by the client at runtime.
    """

    model_config = SettingsConfigDict(
        env_prefix="SANKHYA_COMMUNITY_", env_file=".env", extra="ignore"
    )

    api_url: str = "https://api.bettermode.com"
    network_domain: str = "community.sankhya.com.br"
    # 20 is the safe ceiling: the Bettermode ``spaces`` query 500s when limit
    # exceeds the available count, and posts/replies are well within budget here.
    page_size: int = 20
    delay: float = 0.3
    timeout: float = 60.0
    user_agent: str = "sankhya_ajuda-mcp/0.1"
    # Refresh the guest token this many seconds before its JWT ``exp``.
    token_refresh_margin: int = 300


class SyncSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SYNC_", env_file=".env", extra="ignore")

    log_level: str = Field(default="INFO")


class Settings:
    """Aggregated settings; instantiate once per process via ``get_settings``."""

    def __init__(self) -> None:
        self.pg = PgSettings()
        self.vllm = VllmSettings()
        self.zendesk = ZendeskSettings()
        self.bettermode = BettermodeSettings()
        self.sync = SyncSettings()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
