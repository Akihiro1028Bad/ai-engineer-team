---
name: reviewer-helper
description: Resolve reviewer identity from git config, package.json, or environment
---

# Reviewer Helper

This skill resolves reviewer/author information from multiple sources to prevent "unknown" reviewer issues during code reviews.

## Features

- Resolves reviewer identity from multiple sources with priority order
- Provides helpful suggestions when reviewer cannot be determined
- Reads from: explicit input → local git config → global git config → package.json → environment variables

## Usage

### Basic Usage

