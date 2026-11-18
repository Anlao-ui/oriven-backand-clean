"""Small models trained from scratch in numpy. No pretrained weights.

- LogisticRegression: lead scoring (weighted samples, L2, standardized features).
- RidgeRegression: post performance.
Both serialize to plain JSON.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np


class LogisticRegression:
    def __init__(self, l2: float = 1.0, lr: float = 0.1, epochs: int = 2000):
        self.l2, self.lr, self.epochs = l2, lr, epochs
        self.w = None
        self.b = 0.0
        self.mu = None
        self.sigma = None
        self.feature_names: list[str] = []

    def _std(self, X):
        return (X - self.mu) / self.sigma

    def fit(self, X, y, sample_weight=None, feature_names=None):
        X = np.asarray(X, float)
        y = np.asarray(y, float)
        sw = np.ones(len(y)) if sample_weight is None else np.asarray(sample_weight, float)
        sw = sw / sw.mean()
        self.feature_names = list(feature_names or [f"f{i}" for i in range(X.shape[1])])
        self.mu = X.mean(0)
        self.sigma = X.std(0)
        self.sigma[self.sigma < 1e-6] = 1.0
        Z = self._std(X)
        n, d = Z.shape
        self.w = np.zeros(d)
        self.b = 0.0
        # Full-batch gradient descent with Adam: deterministic and fast for small data.
        m_w = np.zeros(d); v_w = np.zeros(d); m_b = v_b = 0.0
        b1, b2, eps = 0.9, 0.999, 1e-8
        for t in range(1, self.epochs + 1):
            p = 1 / (1 + np.exp(-(Z @ self.w + self.b)))
            err = (p - y) * sw
            g_w = Z.T @ err / n + self.l2 * self.w / n
            g_b = err.mean()
            m_w = b1 * m_w + (1 - b1) * g_w; v_w = b2 * v_w + (1 - b2) * g_w ** 2
            m_b = b1 * m_b + (1 - b1) * g_b; v_b = b2 * v_b + (1 - b2) * g_b ** 2
            self.w -= self.lr * (m_w / (1 - b1 ** t)) / (np.sqrt(v_w / (1 - b2 ** t)) + eps)
            self.b -= self.lr * (m_b / (1 - b1 ** t)) / (np.sqrt(v_b / (1 - b2 ** t)) + eps)
        return self

    def predict_proba(self, X):
        Z = self._std(np.atleast_2d(np.asarray(X, float)))
        return 1 / (1 + np.exp(-(Z @ self.w + self.b)))

    def contributions(self, x):
        """Per-feature contribution to the logit for one sample (for explanations)."""
        z = self._std(np.asarray(x, float))
        return z * self.w

    def to_dict(self):
        return {"type": "logreg", "w": self.w.tolist(), "b": self.b, "mu": self.mu.tolist(),
                "sigma": self.sigma.tolist(), "feature_names": self.feature_names, "l2": self.l2}

    @classmethod
    def from_dict(cls, d):
        m = cls(l2=d.get("l2", 1.0))
        m.w = np.array(d["w"]); m.b = d["b"]; m.mu = np.array(d["mu"]); m.sigma = np.array(d["sigma"])
        m.feature_names = d["feature_names"]
        return m


class RidgeRegression:
    def __init__(self, l2: float = 1.0):
        self.l2 = l2
        self.w = None
        self.b = 0.0
        self.mu = None
        self.sigma = None
        self.feature_names: list[str] = []
        self.resid_std = 1.0
        self.n = 0

    def fit(self, X, y, feature_names=None):
        X = np.asarray(X, float); y = np.asarray(y, float)
        self.feature_names = list(feature_names or [])
        self.mu = X.mean(0); self.sigma = X.std(0); self.sigma[self.sigma < 1e-6] = 1.0
        Z = (X - self.mu) / self.sigma
        self.b = y.mean()
        A = Z.T @ Z + self.l2 * np.eye(Z.shape[1])
        self.w = np.linalg.solve(A, Z.T @ (y - self.b))
        resid = y - (Z @ self.w + self.b)
        self.resid_std = float(max(resid.std(), 1e-3))
        self.n = len(y)
        return self

    def predict(self, X):
        Z = (np.atleast_2d(np.asarray(X, float)) - self.mu) / self.sigma
        return Z @ self.w + self.b

    def to_dict(self):
        return {"type": "ridge", "w": self.w.tolist(), "b": self.b, "mu": self.mu.tolist(),
                "sigma": self.sigma.tolist(), "feature_names": self.feature_names,
                "resid_std": self.resid_std, "n": self.n, "l2": self.l2}

    @classmethod
    def from_dict(cls, d):
        m = cls(l2=d.get("l2", 1.0))
        m.w = np.array(d["w"]); m.b = d["b"]; m.mu = np.array(d["mu"]); m.sigma = np.array(d["sigma"])
        m.feature_names = d["feature_names"]; m.resid_std = d["resid_std"]; m.n = d["n"]
        return m


def save(model, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(model.to_dict(), indent=1), encoding="utf-8")


def load(path: Path):
    d = json.loads(path.read_text(encoding="utf-8"))
    return LogisticRegression.from_dict(d) if d["type"] == "logreg" else RidgeRegression.from_dict(d)
