# Picking workflow — implementation notes

## Agreed operating rule
Picking moves goods from a normal storage location to the dedicated active location whose `location_code` is `STAGING`. It is a MOVE, not an OUT. Physical stock is unchanged; available stock in storage falls immediately, so another salesperson cannot allocate the same units.

## Data model
- `pick_tasks`: one warehouse picking job per source reservation document.
- `pick_task_lines`: requested and picked quantities per original ERP document line (not merely per SKU, because one document can contain duplicate SKU lines).
- `pick_task_move_events`: audit trail for every partial/full move, with an idempotency key and stock transaction reference.
- `pick_task_invoice_lines`: supports multiple invoices against one reservation line without mixing invoice allocations.

## Safety
- Existing products, locations, balances and transaction history are not rewritten by the migration.
- The move RPC locks the task line, checks requested quantity, and calls the existing stock transaction RPC to enforce available-stock guards.
- A repeated request with the same idempotency key returns the original stock transaction rather than moving stock twice.
- Picking cannot use STAGING as a source location.
- The migration file is committed to this feature branch only. It must be reviewed and run in Supabase SQL Editor before enabling the live UI workflow.
- No merge to main and no production database execution is performed here.
