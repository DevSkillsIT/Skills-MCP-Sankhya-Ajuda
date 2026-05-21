"""Pluggable content sources for the sankhya_ajuda ETL.

A *source* knows how to fetch normalized :class:`~sankhya_ajuda.sources.base.Document`
records from some external system (Zendesk help center, Bettermode community, ...).
A *repository* knows how to persist those records for one source. The generic
:class:`~sankhya_ajuda.indexer.DocumentIndexer` ties the two together with the
clean -> hash -> gate -> embed -> upsert loop, source-agnostically.
"""
