// Literal catalog read methods from upstream 26.820.71523; keep cursor behavior under test.
class NativeThreadCatalog {
constructor(db,hostId="local"){this.db=db;this.hostId=hostId;}
readThreadHostId(e){return this.db.prepare(`SELECT host_id, source_recency_at, source_created_at
         FROM local_thread_catalog
         WHERE thread_id = ?
           AND missing_candidate = 0
           AND source_kind != 'chatgpt'
         ORDER BY source_recency_at DESC, source_created_at DESC
         LIMIT 100`).all(e).sort((e,t)=>t.source_recency_at-e.source_recency_at||t.source_created_at-e.source_created_at||e.host_id.localeCompare(t.host_id))[0]?.host_id}readEntry(e){let t=this.db.prepare(`SELECT * FROM local_thread_catalog
         WHERE host_id = ? AND thread_id = ? AND missing_candidate = 0`).get(this.hostId,e);return t==null?null:Sx(t)}readEntries(e){if(e.length>100)throw Error(`Thread catalog entry request exceeds 100`);if(e.length===0)return[];let t=e.map(()=>`?`).join(`, `),n=this.db.prepare(`SELECT * FROM local_thread_catalog
         WHERE host_id = ?
           AND thread_id IN (${t})
           AND missing_candidate = 0`).all(this.hostId,...e),r=new Map(n.flatMap(e=>{let t=Sx(e);return t==null?[]:[[t.threadId,t]]}));return e.flatMap(e=>{let t=r.get(e);return t==null?[]:[t]})}readPage({limit:e,cursor:t,filter:n,manualOrder:r,sortKey:i}){if(!Number.isInteger(e)||e<1||e>100)throw Error(`Thread catalog page limit must be between 1 and 100`);if(r!=null){if(r.threadIds.length>100)throw Error(`Thread catalog manual order exceeds 100`);if(t!=null)throw Error(`Manual thread catalog pages do not use a cursor`);return this.readManualPage(r,n,e)}if(t!=null&&t.sortKey!==i)throw Error(`Thread catalog cursor uses a different sort order`);let a=e+1,o=i===`created_at`?`source_created_at`:`source_recency_at`,s=i===`created_at`?`source_updated_at`:`source_created_at`,c=i===`created_at`?t?.sourceCreatedAt:t?.sourceRecencyAt,l=i===`created_at`?t?.sourceUpdatedAt:t?.sourceCreatedAt,u=i===`created_at`?`local_thread_catalog_cwd_created_idx`:`local_thread_catalog_cwd_updated_idx`,d=t==null?``:`AND (
             ${o} < ?
             OR (
               ${o} = ?
               AND ${s} < ?
             )
             OR (
               ${o} = ?
               AND ${s} = ?
               AND thread_id > ?
             )
           )`,f=t==null?[]:[c,c,l,c,l,t.threadId],p=(()=>{let e=bx(n);if(e!=null){let t=``;return i===`updated_at`&&(n?.projectId===void 0?n?.conversationOrigin===`tpp`&&(t=`INDEXED BY local_thread_catalog_origin_updated_idx`):t=`INDEXED BY local_thread_catalog_project_updated_idx`),this.db.prepare(`SELECT * FROM local_thread_catalog ${t}
             WHERE host_id = ?
               AND missing_candidate = 0
               ${e.clause}
               AND thread_id NOT IN (SELECT value FROM json_each(?))
               ${d}
             ORDER BY ${o} DESC, ${s} DESC, thread_id
             LIMIT ?`).all(this.hostId,...e.params,JSON.stringify(n?.excludeThreadIds??[]),...f,a)}if(n==null||n.includeAll===!0){let e=JSON.stringify(n?.excludeThreadIds??[]);return this.db.prepare(`SELECT * FROM local_thread_catalog
             WHERE host_id = ?
               AND missing_candidate = 0
               AND thread_id NOT IN (SELECT value FROM json_each(?))
               ${d}
             ORDER BY ${o} DESC, ${s} DESC, thread_id
             LIMIT ?`).all(this.hostId,e,...f,a)}let t=JSON.stringify(n.cwdValues),r=JSON.stringify(xx(n.cwdPrefixes)),c=JSON.stringify(n.excludeThreadIds);return this.db.prepare(`WITH exact_cwd AS (
             SELECT * FROM local_thread_catalog
               INDEXED BY ${u}
             WHERE host_id = ?
               AND missing_candidate = 0
               AND cwd IN (SELECT value FROM json_each(?))
               AND thread_id NOT IN (SELECT value FROM json_each(?))
               ${d}
             ORDER BY ${o} DESC, ${s} DESC, thread_id
             LIMIT ?
           ), prefixed_cwd AS (
             SELECT catalog.* FROM json_each(?) AS prefix
               CROSS JOIN local_thread_catalog AS catalog
               INDEXED BY ${u}
             WHERE catalog.host_id = ?
               AND catalog.missing_candidate = 0
               AND catalog.cwd >= prefix.value
               AND catalog.cwd < prefix.value || char(1114111)
               AND catalog.cwd NOT IN (SELECT value FROM json_each(?))
               AND catalog.thread_id NOT IN (SELECT value FROM json_each(?))
               ${d}
             ORDER BY ${o} DESC, ${s} DESC, thread_id
             LIMIT ?
           ), included_thread AS (
             SELECT * FROM local_thread_catalog
             WHERE host_id = ?
               AND missing_candidate = 0
               AND thread_id IN (SELECT value FROM json_each(?))
               AND cwd NOT IN (SELECT value FROM json_each(?))
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(?) AS prefix
                 WHERE cwd >= prefix.value
                   AND cwd < prefix.value || char(1114111)
               )
               AND thread_id NOT IN (SELECT value FROM json_each(?))
               ${d}
             ORDER BY ${o} DESC, ${s} DESC, thread_id
             LIMIT ?
           ), scoped AS (
             SELECT * FROM exact_cwd
             UNION ALL
             SELECT * FROM prefixed_cwd
             UNION ALL
             SELECT * FROM included_thread
           )
           SELECT * FROM scoped
           ORDER BY ${o} DESC, ${s} DESC, thread_id
           LIMIT ?`).all(this.hostId,t,c,...f,a,r,this.hostId,t,c,...f,a,this.hostId,JSON.stringify(n.includeThreadIds),t,r,c,...f,a,a)})().flatMap(e=>{let t=Sx(e);return t==null?[]:[t]}),m=p.slice(0,e),h=m.at(-1);return{entries:m,nextCursor:p.length>e&&h!=null?{sortKey:i,sourceUpdatedAt:h.sourceUpdatedAt,sourceRecencyAt:h.sourceRecencyAt,sourceCreatedAt:h.sourceCreatedAt,threadId:h.threadId}:null}}readManualPage(e,t,n){let r=bx(t,`catalog.`),i=t==null||t.includeAll===!0?``:`AND (
             catalog.cwd IN (SELECT value FROM json_each(?))
             OR EXISTS (
               SELECT 1 FROM json_each(?) AS prefix
               WHERE catalog.cwd >= prefix.value
                 AND catalog.cwd < prefix.value || char(1114111)
             )
             OR catalog.thread_id IN (SELECT value FROM json_each(?))
           )`,a=t==null?``:`AND catalog.thread_id NOT IN (SELECT value FROM json_each(?))
           ${i}`,o=t==null?[]:[JSON.stringify(t.excludeThreadIds),...t.includeAll===!0?[]:[JSON.stringify(t.cwdValues),JSON.stringify(xx(t.cwdPrefixes)),JSON.stringify(t.includeThreadIds)]],s=this.db.prepare(`WITH manual AS (
           SELECT CAST(key AS INTEGER) AS position, value AS thread_id
           FROM json_each(?)
           WHERE CAST(key AS INTEGER) >= ?
         )
         SELECT catalog.*, manual.position AS manual_position
         FROM manual
         JOIN local_thread_catalog AS catalog
           ON catalog.host_id = ?
          AND catalog.thread_id = manual.thread_id
         WHERE catalog.missing_candidate = 0
           ${a}
           ${r?.clause??``}
         ORDER BY manual.position
         LIMIT ?`).all(JSON.stringify(e.threadIds),e.startIndex,this.hostId,...o,...r?.params??[],n+1),c=s.slice(0,n).flatMap(e=>{let t=Sx(e);return t==null?[]:[t]}),l=s.at(n);return{entries:c,nextManualIndex:l==null?null:Number(l.manual_position),nextCursor:null}}
}
