"""Channel rule under Dutch law (Telecommunicatiewet art. 11.7).

Cold B2B email is only allowed to legal entities (rechtspersonen: B.V., N.V., Stichting,
Vereniging, Coöperatie), always with an opt-out. Natural persons (eenmanszaak, zzp, V.O.F.,
C.V. and anything unknown) never get cold email: channel is LinkedIn or contact form.
"""
from __future__ import annotations

from .signals import LEGAL_ENTITIES

EMAIL = "email"
MANUAL = "linkedin_of_contactformulier"
NONE = "geen"


def decide_channel(legal_form: str | None, email: str | None, opted_out: bool = False) -> str:
    if opted_out:
        return NONE
    if legal_form in LEGAL_ENTITIES and email:
        return EMAIL
    return MANUAL
