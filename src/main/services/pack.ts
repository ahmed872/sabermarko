/**
 * The pack a product is bought and shelved in (carton, dozen…): its purchase unit, else its biggest unit, holding a
 * whole number (> 1) of the base unit, for products counted in pieces. Joins as `pk` (product_units) + `pku` (units);
 * needs the product aliased `p` and its base unit aliased `<baseAlias>`.
 */
export const packJoin = (baseAlias: string) => `
     LEFT JOIN product_units pk ON pk.id = (
       SELECT x.id FROM product_units x JOIN units xu ON xu.id = x.unit_id
        WHERE x.product_id = p.id AND x.unit_id <> p.base_unit_id AND x.factor > 1000 AND x.factor % 1000 = 0 AND xu.kind = 'count' AND ${baseAlias}.kind = 'count'
        ORDER BY x.is_default_purchase DESC, x.factor DESC LIMIT 1)
     LEFT JOIN units pku ON pku.id = pk.unit_id`;
