# Product Intelligence Data Model

## Goal
One record should explain what was observed, where it came from, what is still unknown, and why a product is or is not worth testing.

## Recommended fields
| Field | Meaning |
|---|---|
| product_id | Stable internal ID |
| product_name | Exact listing/product name |
| niche | Current portfolio lane |
| platform | TikTok Shop, Shopee, or other verified platform |
| listing_url | Canonical product URL |
| seller_name | Seller shown on listing |
| date_checked | ISO date in local context |
| price_idr | Price actually observed; record variation/coupon separately |
| commission_rate | Rate from current official affiliate terms |
| commission_basis | Gross/net, conditions, eligibility, if known |
| rating / review_count | Observed values with timestamp; blank if absent |
| demand_signals | Actual observed comments, questions, ranking, orders where visible |
| evidence_grade | A/B/C/D with source rationale |
| source_urls | Links to primary and secondary sources |
| content_rights | Original footage, seller-approved assets, licensed, or unknown |
| content_angles | Specific, truthful test angles |
| status | Researching / Ready to test / Testing / Scale candidate / Hold / Rejected |
| clicks / orders | Actual measured values and period |
| approved_commission_idr | Actual approved commission from dashboard |
| cancellations_returns | Actual observed values |
| production_minutes | Time spent producing content |
| caveats | Missing data, uncertainty, conflicts, changes |

## Rules
- Use blank/unknown for missing values, never zero unless zero was actually observed.
- Keep price and commission snapshots with the date checked.
- Distinguish advertised commission from approved earnings.
- Separate observations from interpretation.
- Keep source URLs and avoid copying personal data from commenters.
- Avoid storing credentials, private messages, or unnecessary personal information.
- Do not infer sales from views, reviews, likes, or creator popularity.
- Export regularly if using a temporary/local prototype.

## Example of a blank record
```csv
product_id,product_name,niche,platform,listing_url,seller_name,date_checked,price_idr,commission_rate,evidence_grade,status,clicks,orders,approved_commission_idr,cancellations_returns,production_minutes,caveats
,,,,,,,,,,Researching,,,,,,
```

## Minimum decision packet
Before testing, have: exact listing, verified terms, target audience, one audience problem, one creative hypothesis, rights/asset plan, platform eligibility check, risk review, and a decision rule.
