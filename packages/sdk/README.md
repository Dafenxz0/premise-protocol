# @premise/sdk

The public TypeScript client for the PREMiSE v2 HTTP API.

PREMiSE helps an agent keep information tied to a source, notice when that
source changes, and make a guarded decision before acting on it. This package
is the network client. It is not a database, vector index, embedding service,
or truth oracle.

## Install

    npm install @premise/sdk

The package requires Node.js 24.

## First request

    import { PremiseClient } from "@premise/sdk";

    const premise = new PremiseClient({
      baseUrl: "https://premise.example.com/",
      tenantId: "acme",
      token: process.env.PREMISE_TOKEN
    });

    const health = await premise.health();
    const result = await premise.query("Which release is current?", { limit: 5 });

The SDK validates response shapes, propagates request and idempotency headers,
supports bounded retries, and fails closed on malformed responses. See the
repository integration guide for the full register, revalidate, and
source-changed workflows.

## Compatibility

This release candidate speaks the premise/2 HTTP API. The package itself has no
runtime dependency on the PREMiSE monorepo, so it can be installed by an
external Node project.

## Status

The SDK is a candidate public surface, not a promise that every PREMiSE
deployment is production-ready. Real connector, operational, and security
claims must be supported by the corresponding certification artifacts.
