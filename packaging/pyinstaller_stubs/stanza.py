import re


class _Sentence:
    def __init__(self, text):
        self.text = text


class _Document:
    def __init__(self, text):
        pieces = [piece.strip() for piece in re.split(r"(?<=[.!?])\s+", text or "") if piece.strip()]
        self.sentences = [_Sentence(piece) for piece in pieces] or [_Sentence(text or "")]


class Pipeline:
    def __init__(self, *args, **kwargs):
        pass

    def __call__(self, text):
        return _Document(text)
