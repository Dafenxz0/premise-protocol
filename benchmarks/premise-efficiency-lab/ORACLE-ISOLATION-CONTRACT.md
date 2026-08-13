# Candidate/oracle isolation contract v1

Efficiency Lab v1 has two physically separate roles.

## Candidate process

The candidate may receive:

```text
taskId
public memory and graph observations
events delivered so far
declared connector capabilities
risk level
tenant and principal scope
allowed operations
```

The candidate may return:

```text
USE / VALIDATE / REJECT / ACTION
public receipts
physical operation trace
```

## Oracle process

The oracle alone may receive:

```text
private mutation schedule
true affected set
current source versions
expected reference decision
candidate action result
```

It produces safety labels and minimum-work certificates after the candidate
has finished. It must not provide a callback or object to the candidate that
can inspect private truth.

## Boundary rules

- Candidate and oracle use separate child processes.
- Candidate and oracle read different NDJSON inputs.
- Private manifests, mappings and truth stay outside candidate directories.
- A dataset hash is published before the holdout starts.
- Candidate input is recursively scanned for forbidden keys.
- Candidate output is scanned for accidental truth fields.
- Candidate failures are not silently converted into safe results.
- Partial campaigns are ineligible for ranking.

The checked-in `sealed/local` smoke currently implements the candidate as a
child process and keeps the mutation schedule, source broker and examiner in
the parent. It deliberately reports `holdoutIndependent: false`: a separate
oracle process, OS sandbox and external sealed holdout remain future gates.

Forbidden keys include:

```text
oracle
truth
sourceTruth
expected
expectedDecision
expectedOutcome
oracleDecision
affectedSet
actualAffectedTarget
groundTruth
trueVersion
candidateName
mapping
candidateMapping
hiddenLabels
```

The test suite must deliberately inject each class of forbidden field and
confirm that the boundary fails closed.
