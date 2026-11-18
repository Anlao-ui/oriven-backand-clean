"""Official Instagram Graph API (business account): publish photo, carousel, reel; read insights."""
from __future__ import annotations

import time

import requests

GRAPH = "https://graph.facebook.com/v21.0"


class Instagram:
    def __init__(self, user_id: str, token: str):
        self.user_id, self.token = user_id, token

    def _post(self, path: str, **params) -> dict:
        r = requests.post(f"{GRAPH}/{path}", data={**params, "access_token": self.token}, timeout=60)
        data = r.json()
        if "error" in data:
            raise RuntimeError(data["error"].get("message", str(data["error"])))
        return data

    def _get(self, path: str, **params) -> dict:
        r = requests.get(f"{GRAPH}/{path}", params={**params, "access_token": self.token}, timeout=60)
        data = r.json()
        if "error" in data:
            raise RuntimeError(data["error"].get("message", str(data["error"])))
        return data

    def _wait(self, container_id: str, timeout: int = 600) -> None:
        start = time.time()
        while time.time() - start < timeout:
            status = self._get(container_id, fields="status_code").get("status_code")
            if status == "FINISHED":
                return
            if status in ("ERROR", "EXPIRED"):
                raise RuntimeError(f"container {container_id}: {status}")
            time.sleep(5)
        raise TimeoutError(container_id)

    def publish(self, kind: str, urls: list[str], caption: str) -> str:
        """urls must be public HTTPS URLs (Instagram fetches the media itself)."""
        if kind == "reel":
            c = self._post(f"{self.user_id}/media", media_type="REELS", video_url=urls[0], caption=caption)["id"]
        elif kind == "carousel":
            children = [self._post(f"{self.user_id}/media", image_url=u, is_carousel_item="true")["id"] for u in urls[:10]]
            for ch in children:
                self._wait(ch)
            c = self._post(f"{self.user_id}/media", media_type="CAROUSEL", children=",".join(children),
                           caption=caption)["id"]
        else:
            c = self._post(f"{self.user_id}/media", image_url=urls[0], caption=caption)["id"]
        self._wait(c)
        return self._post(f"{self.user_id}/media_publish", creation_id=c)["id"]

    def insights(self, media_id: str, kind: str) -> dict:
        metrics = "reach,likes,comments,saved,shares" + (",total_interactions" if kind == "reel" else "")
        data = self._get(f"{media_id}/insights", metric=metrics).get("data", [])
        out = {d["name"]: (d.get("values") or [{}])[0].get("value", d.get("total_value", {}).get("value", 0))
               for d in data}
        return {"reach": out.get("reach", 0), "likes": out.get("likes", 0), "comments": out.get("comments", 0),
                "saves": out.get("saved", 0), "shares": out.get("shares", 0), "clicks": 0}
