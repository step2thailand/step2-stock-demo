(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 const fileInput=$('documentImportFile');
 if(!fileInput)return;
 const seenDocumentNumbers=new Set();
 const setStatus=(text,error=false)=>{const el=$('documentImportStatus');el.textContent=text;el.className='status '+(error?'error':'success');};
 const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function toISO(raw){
   const m=String(raw||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
   if(!m)return '';
   const day=Number(m[1]),month=Number(m[2]);
   let year=Number(m[3]);
   if(year<100)year+=2500;
   if(year>=2400)year-=543;
   const d=new Date(Date.UTC(year,month-1,day));
   if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return '';
   return String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
 }
 function displayThaiDate(iso){
   const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
   if(!m)return '';
   return m[3]+'/'+m[2]+'/'+String(Number(m[1])+543);
 }
 const normalize=s=>String(s??'').replace(/\s+/g,' ').trim();
 const productBySku=sku=>(typeof window.getInventoryProducts==='function'?window.getInventoryProducts():[]).find(p=>String(p.sku??'').trim()===String(sku).trim());
 function groupRows(items,tolerance=2.8){
   const sorted=items.filter(x=>normalize(x.str)).map(x=>({text:normalize(x.str),x:x.x,y:x.y})).sort((a,b)=>a.y-b.y||a.x-b.x);
   const rows=[];
   for(const item of sorted){
     let row=rows.find(r=>Math.abs(r.y-item.y)<=tolerance);
     if(!row){row={y:item.y,items:[]};rows.push(row);}
     row.items.push(item);
     row.y=row.items.reduce((s,v)=>s+v.y,0)/row.items.length;
   }
   return rows.map(r=>({y:r.y,items:r.items.sort((a,b)=>a.x-b.x),text:r.items.map(x=>x.text).join(' ')})).sort((a,b)=>a.y-b.y);
 }
 function findCell(row,minX,maxX,pattern){
   return row.items.filter(x=>x.x>=minX&&x.x<maxX).map(x=>x.text).find(s=>pattern.test(s))||'';
 }
 function parsePositioned(pages){
   const pageRows=pages.map(items=>groupRows(items));
   const allItems=pages.flat();
   const rows=pageRows.flat();
   const allText=rows.map(r=>r.text).join('\n');
   const docNoItem=allItems.find(x=>x.x>=400&&/\b(?:Q|BK)\d{6}\/\d{4,6}\b/i.test(x.str));
   const number=(docNoItem?.str.match(/\b(?:Q|BK)\d{6}\/\d{4,6}\b/i)||[])[0]||'';
   const quote=/ใบเสนอราคา|quotation|\bQ\d{6}\//i.test(allText);
   const reservation=/ใบจอง|\bBK\d{6}\//i.test(allText);
   // Customer name is the text immediately following the document's
   // customer label. It may be in the same PDF text fragment, the next
   // fragment on the same line, or the immediately following visual line.
   function readLabeledValue(labels){
     const labelRe=/^(?:เรียน|Attention\b|\(ชื่อ\)|ชื่อ\s*[:：]?)[\s:：]*/i;
     const reject=/^(?:ที่อยู่|โทร|โทรศัพท์|เลขที่|วันที่|เรียน|Attention|\(ชื่อ\)|ชื่อ|คุณลูกค้า|customer)\b/i;
     // PDF.js may split the label and customer into separate positioned items.
     // Match the label first, then read the next text immediately to its right.
     for(const page of pages){
       const positioned=page.filter(x=>normalize(x.str)).slice().sort((a,b)=>a.y-b.y||a.x-b.x);
       for(let i=0;i<positioned.length;i++){
         const item=positioned[i],raw=normalize(item.str);
         if(!labels.some(re=>re.test(raw)))continue;
         const inline=normalize(raw.replace(labelRe,''));
         if(inline&&!reject.test(inline))return inline;
         const right=positioned
           .filter(x=>x!==item&&Math.abs(x.y-item.y)<=7&&x.x>item.x)
           .sort((a,b)=>a.x-b.x)
           .map(x=>normalize(x.str))
           .find(v=>v&&!reject.test(v));
         if(right)return right;
         // Fallback for PDFs that place the value on the immediately lower line.
         const below=positioned
           .filter(x=>x!==item&&x.y>item.y&&x.y-item.y<=22&&x.x>=item.x-8)
           .sort((a,b)=>a.y-b.y||a.x-b.x)
           .map(x=>normalize(x.str))
           .find(v=>v&&!reject.test(v));
         if(below)return below;
       }
     }
     return '';
   }
   const customerName=quote
     ? readLabeledValue([/^เรียน(?:\s|[:：]|$)/i,/^Attention\b/i])
     : reservation ? readLabeledValue([/^\(ชื่อ\)/i,/^ชื่อ\s*[:：]/i]) : '';
   // Parse each page independently because PDF coordinates restart at the top
   // of every page. This prevents page 2 rows from being merged with page 1.
   const candidates=[];
   const productPages=quote?pages.map(items=>groupRows(items,7)):pageRows;
   for(const page of productPages){
     const header=page.find(r=>r.y>=180&&r.y<=320&&/รห.*สนค|รหัสสินค้า|SKU/i.test(r.text));
     const quantityHeader=page.find(r=>r.y>=180&&r.y<=320&&/จำนวน|qty|quantity/i.test(r.text));
     const tableHeader=header||quantityHeader;
     const tableTop=tableHeader?.y??255;
     const totalRow=page.find(r=>r.y>tableTop&&/รวมท.*หมด|รวมทั้งหมด|ยอดรวม|grand total/i.test(r.text));
     const lower=totalRow?.y??560;
     for(const row of page){
       if(row.y<=tableTop+2||row.y>=lower)continue;
       // Prefer the expected SKU column. For quotation layouts that place
       // the SKU elsewhere, accept an exact SKU already present in inventory.
       const skuInColumn=findCell(row,18,115,/^(?:\d{3,5}|\d{1,4}\/\d{1,4})$/);
       const skuAnywhere=row.items.map(x=>normalize(x.text)).find(s=>
         /^(?:\d{3,5}|\d{1,4}\/\d{1,4})$/.test(s)&&(s==='4/2'||!!productBySku(s))
       );
       const sku=skuInColumn||(quote?skuAnywhere:'');
       if(!sku)continue;
       // Use the quantity column's own header position when available;
       // retain the known reservation coordinates as a fallback.
       const quantityHeaderX=quantityHeader?.items.find(x=>/จำนวน|qty|quantity/i.test(x.text))?.x;
       const quantityCell=Number.isFinite(quantityHeaderX)
         ? row.items.filter(x=>/^\d+(?:\.\d+)?$/.test(x.text))
             .sort((a,b)=>Math.abs(a.x-quantityHeaderX)-Math.abs(b.x-quantityHeaderX))[0]
         : null;
       const qtyText=quantityCell?.text||findCell(row,335,430,/^\d+(?:\.\d+)?$/);
       if(!qtyText)continue;
       const quantity=Number(qtyText);
       if(!Number.isFinite(quantity)||quantity<=0)continue;
       const name=row.items.filter(x=>x.x>=120&&x.x<310).map(x=>x.text).join(' ').trim();
       const service=sku==='4/2'||/ค่าบริการ|บริการจัดส่ง|จตดสทง|shipping|delivery service/i.test(name);
       const product=service?null:productBySku(sku);
       const displayName=sku==='4/2'?'ค่าบริการจัดส่งสินค้า':(product?.product_name||name||'ไม่พบชื่อในฐานข้อมูลสินค้า');
       candidates.push({sku,name:displayName,quantity:Math.round(quantity),is_inventory:!service,unit:service?'ครั้ง':'ชุด',matched_product:service||!!product,_y:row.y});
     }
   }
   // De-duplicate repeated text fragments for the same SKU/quantity/row.
   const seen=new Set(),items=candidates.filter(x=>{
     const key=[x.sku,x.quantity,x._y].join('|');
     if(seen.has(key))return false;seen.add(key);return true;
   }).map(({_y,...x})=>x);
   const dateRows=rows.filter(r=>r.y>=125&&r.y<=215);
   const dateCells=dateRows.map(r=>({y:r.y,value:findCell(r,400,590,/^\d{1,2}\/\d{1,2}\/\d{2,4}$/)})).filter(x=>x.value);
   const date=dateCells[0]?.value||'';
   const dueDate=dateCells[1]?.value||'';
   const expiryDate=dateCells[2]?.value||'';
   const deliveryRow=rows.find(r=>r.y>=205&&r.y<=220&&r.items.some(x=>x.x>=430&&x.x<=510));
   const deliveryRaw=deliveryRow?.items.filter(x=>x.x>=430&&x.x<=540).map(x=>x.text).join(' ').trim()||'';
   const deliveryMatch=deliveryRaw.match(/รับเอง|รตบเอง|รบเอง|Flash\s*Express|Kerry|J&T|ไปรษณีย์|ขนส่ง|จัดส่ง/i);
   const delivery=deliveryMatch?(/รตบเอง|รบเอง|รับเอง/i.test(deliveryMatch[0])?'รับเอง':deliveryMatch[0]):'';
   const warnings=[];
   if(!number)warnings.push('ไม่พบเลขที่เอกสารในตำแหน่งหัวเอกสาร กรุณาตรวจสอบและกรอกเอง');
   if(!date)warnings.push('ไม่พบวันที่เอกสารในตำแหน่งที่คาดไว้ กรุณาตรวจสอบ');
   if(!customerName)warnings.push(quote?'ไม่พบชื่อลูกค้าหลัง เรียน / Attention กรุณากรอกเอง':'ไม่พบชื่อลูกค้าหลัง (ชื่อ) กรุณากรอกเอง');
   if(quote&&!delivery)warnings.push('ใบเสนอราคาไม่พบวิธีจัดส่งที่อ่านได้ชัดเจน จึงเว้นช่องนี้ว่างไว้ กรุณากรอกหรือยืนยันเอง');
   if(!quote&&!delivery)warnings.push('ไม่พบวิธีจัดส่งที่อ่านได้ชัดเจน กรุณาตรวจสอบและกรอกเอง');
   if(!items.length)warnings.push('ไม่พบแถวสินค้าในบริเวณตาราง กรุณาตรวจสอบรูปแบบ PDF');
   if(quote){
     for(const expected of ['4931','4206']){
       if(!items.some(x=>x.sku===expected))warnings.push('ไม่พบ SKU '+expected+' ในใบเสนอราคาตัวอย่าง กรุณาตรวจสอบรายการสินค้าและจำนวนด้วยตนเอง');
     }
   }
   if(items.some(x=>!x.matched_product&&!['4/2'].includes(x.sku)))warnings.push('มี SKU ที่ไม่พบในฐานข้อมูลสินค้า กรุณาตรวจสอบก่อนใช้งาน');
   if(items.some(x=>x.sku==='4/2'))warnings.push('พบ SKU 4/2 ซึ่งเป็นค่าบริการ ไม่ควรนับเป็นสินค้าในคลัง');
   if(reservation&&/รับเอง/.test(allText)&&/Flash Express|ขนส่ง/i.test(allText))warnings.push('ข้อมูลวิธีจัดส่งขัดแย้งกัน: ช่องวิธีจัดส่งระบุ “รับเอง” แต่หมายเหตุระบุ Flash Express กรุณาตรวจสอบ');
   if(number&&seenDocumentNumbers.has(number))warnings.push('พบเลขที่เอกสารนี้ซ้ำกับไฟล์ที่อ่านไปแล้วในรอบการใช้งานนี้');
   return {type:quote?'QUOTATION':reservation?'RESERVATION':'UNKNOWN',customerName,number,date:toISO(date),dueDate:toISO(dueDate),expiryDate:toISO(expiryDate),delivery,items,warnings,rawText:allText};
 }

 function parseExcel(workbook){
   if(!window.XLSX)throw new Error('โหลดตัวอ่าน Excel ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่');
   const sheetTexts=workbook.SheetNames.map(name=>{
     const ws=workbook.Sheets[name];
     return {name,ws,text:Object.keys(ws).filter(k=>k[0]!=='!').map(k=>String(ws[k]?.w??ws[k]?.v??'')).join(' ')};
   });
   const allText=sheetTexts.map(x=>x.text).join(' ');
   const reservation=/ใบจองสินค้า|ใบจอง|\bBK\d{6}\//i.test(allText);
   const quote=!reservation&&(/ใบเสนอราคา|quotation|\bQ\d{6}\//i.test(allText));
   const type=reservation?'RESERVATION':quote?'QUOTATION':'UNKNOWN';
   if(type==='UNKNOWN')throw new Error('ไม่สามารถระบุประเภทเอกสารได้ กรุณาตรวจสอบว่าเป็นไฟล์ใบเสนอราคาหรือใบจองจาก Business Plus');
   const col=reservation?{sku:4,name:15,qty:27,unit:25,price:38,discount:43,net:48}:{sku:1,name:5,qty:12,unit:13,price:14,discount:15,net:16};
   const cellValue=(ws,r,c)=>{
     const cell=ws[XLSX.utils.encode_cell({r:r-1,c})];
     if(!cell||cell.v===undefined||cell.v===null)return '';
     return String(cell.w!==undefined?cell.w:cell.v).trim();
   };
   const numeric=(v)=>{
     const n=Number(String(v??'').replace(/,/g,'').replace(/[฿\s]/g,''));
     return Number.isFinite(n)?n:null;
   };
   const dateValue=(ws,address)=>{
     const cell=ws[address];if(!cell)return '';
     if(typeof cell.v==='number'&&cell.t==='n'&&cell.z&&/[ymd]/i.test(cell.z)){
       const d=XLSX.SSF.parse_date_code(cell.v);
       if(d)return String(d.d).padStart(2,'0')+'/'+String(d.m).padStart(2,'0')+'/'+String(d.y);
     }
     return String(cell.w!==undefined?cell.w:cell.v??'').trim();
   };
   const metadataSheet=sheetTexts.find(x=>x.text.trim())?.ws;
   const numberAddress=reservation?'AN16':'U12';
   const dateAddress=reservation?'AN20':'U14';
   const customerAddress=reservation?'F14':'G12';
   const number=dateValue(metadataSheet,numberAddress);
   const date=dateValue(metadataSheet,dateAddress);
   const customerName=dateValue(metadataSheet,customerAddress);
   const dueDate=reservation?dateValue(metadataSheet,'AN29'):'';
   const expiryDate=reservation?dateValue(metadataSheet,'AN33'):'';
   const delivery=reservation?dateValue(metadataSheet,'AN37'):'';
   const items=[],parsedSheets=[];
   for(const entry of sheetTexts){
     const ws=entry.ws;
     let headerRow=0,skuCol=col.sku,qtyCol=col.qty,nameCol=col.name,unitCol=col.unit,priceCol=col.price,discountCol=col.discount,netCol=col.net;
     for(let r=1;r<=Math.min(ws['!ref']?XLSX.utils.decode_range(ws['!ref']).e.r+1:ws['!rows']?.length||200,250);r++){
       const rowText=Array.from({length:Math.min(ws['!ref']?XLSX.utils.decode_range(ws['!ref']).e.c+1:52,60)},(_,c)=>cellValue(ws,r,c)).join(' ');
       if(/รหัสสินค้า|รหสสนค|รหัส\s*สินค้า/i.test(rowText)&&/จำนวน|qty|quantity/i.test(rowText)){headerRow=r;break;}
     }
     if(!headerRow){
       // Some exports place continuation rows on a second Worksheet without repeating the header.
       const lastRow=ws['!ref']?XLSX.utils.decode_range(ws['!ref']).e.r+1:0;
       const hasData=Array.from({length:lastRow},(_,i)=>i+1).some(r=>{
         const candidate=cellValue(ws,r,skuCol),qty=numeric(cellValue(ws,r,qtyCol));
         return !!candidate&&qty!==null&&qty>0&&candidate.length<=40;
       });
       if(!hasData)continue;
       headerRow=0;
     }
     // Locate columns from the header labels, falling back to the known Business Plus layouts.
     const maxCol=Math.min(XLSX.utils.decode_range(ws['!ref']).e.c+1,60);
     for(let c=0;c<maxCol;c++){
       const v=cellValue(ws,headerRow,c);
       if(/รหัสสินค้า|รหสสนค/i.test(v))skuCol=c;
       else if(/รายการสินค้า|รายการ|product/i.test(v))nameCol=c;
       else if(/จำนวน|qty|quantity/i.test(v))qtyCol=c;
       else if(/หน่วยนับ|หน่วย/i.test(v))unitCol=c;
       else if(/ราคา\s*\/\s*หน่วย|ราคา@|unit price/i.test(v))priceCol=c;
       else if(/ส่วนลด|discount/i.test(v))discountCol=c;
       else if(/ราคาสุทธิ|net price/i.test(v))netCol=c;
     }
     let sheetCount=0;
     for(let r=headerRow+1;r<=XLSX.utils.decode_range(ws['!ref']).e.r+1;r++){
       const sku=cellValue(ws,r,skuCol);
       if(!sku||/รหัสสินค้า|รหสสนค/i.test(sku))continue;
       const qtyText=cellValue(ws,r,qtyCol),quantity=numeric(qtyText);
       if(quantity===null||quantity<=0)continue;
       // Ignore totals and non-SKU labels; retain slash SKUs such as 4/1 and 4/2 as text.
       if(sku.length>40||/รวม|หมายเหตุ|total/i.test(sku))continue;
       const name=cellValue(ws,r,nameCol);
       const service=sku==='4/2'||/ค่าบริการจัดส่ง|บริการจัดส่ง|ค่าขนส่ง|delivery service|shipping service/i.test(name);
       const product=service?null:productBySku(sku);
       const unit=cellValue(ws,r,unitCol);
       const price=numeric(cellValue(ws,r,priceCol));
       const discount=cellValue(ws,r,discountCol);
       const net=numeric(cellValue(ws,r,netCol));
       items.push({
         sku,name:sku==='4/2'?'ค่าบริการจัดส่งสินค้า':(product?.product_name||name||'ไม่พบชื่อในฐานข้อมูลสินค้า'),
         quantity,unit:unit|| (service?'ครั้ง':'ชุด'),price,discount,net,
         is_inventory:!service,matched_product:service||!!product,
         source_sheet:entry.name,source_row:r
       });
       sheetCount++;
     }
     if(sheetCount)parsedSheets.push(entry.name);
   }
   const warnings=[];
   if(!number)warnings.push('ไม่พบเลขที่เอกสารในช่องมาตรฐาน กรุณาตรวจสอบและกรอกเอง');
   if(!date||!toISO(date))warnings.push('ไม่พบวันที่เอกสารหรือรูปแบบวันที่ไม่ถูกต้อง กรุณาตรวจสอบ');
   if(!customerName)warnings.push('ไม่พบชื่อลูกค้าในช่องมาตรฐาน กรุณากรอกเอง');
   if(!items.length)warnings.push('ไม่พบรายการสินค้าในตาราง กรุณาตรวจสอบรูปแบบไฟล์ Excel');
   if(items.some(x=>!x.matched_product&&!['4/2'].includes(x.sku)))warnings.push('มี SKU ที่ไม่พบในฐานข้อมูลสินค้า กรุณาตรวจสอบก่อนใช้งาน');
   if(items.some(x=>x.sku==='4/2'))warnings.push('พบ SKU 4/2 ซึ่งเป็นค่าบริการ ไม่ควรนับเป็นสินค้าในคลัง');
   if(reservation&&!delivery)warnings.push('ไม่พบวิธีจัดส่งในช่องมาตรฐาน กรุณาตรวจสอบ');
   const invalidQty=items.filter(x=>!Number.isInteger(x.quantity));
   if(invalidQty.length)warnings.push('พบจำนวนที่ไม่ใช่จำนวนเต็ม '+invalidQty.length+' รายการ กรุณาตรวจสอบ');
   if(number&&seenDocumentNumbers.has(number))warnings.push('พบเลขที่เอกสารนี้ซ้ำกับไฟล์ที่อ่านไปแล้วในรอบการใช้งานนี้');
   return {type,customerName,number,date:toISO(date),dueDate:toISO(dueDate),expiryDate:toISO(expiryDate),delivery,items,warnings,rawText:allText,sourceSheets:parsedSheets};
 }

 function render(result){
   $('diCustomerName').value=result.customerName||'';
   $('diType').value=result.type;$('diNumber').value=result.number;
   $('diDate').value=displayThaiDate(result.date);
   $('diDueDate').value=displayThaiDate(result.dueDate);
   $('diExpiryDate').value=displayThaiDate(result.expiryDate);
   $('diDelivery').value=result.delivery;
   $('documentImportWarnings').innerHTML=result.warnings.length?'<strong>โปรดตรวจสอบ</strong><ul>'+result.warnings.map(x=>'<li>'+escapeHtml(x)+'</li>').join('')+'</ul>':'<strong>ไม่พบคำเตือนจากการอ่านเบื้องต้น</strong>';
   $('documentImportWarnings').classList.remove('hidden');
   $('documentImportLines').innerHTML=result.items.length?result.items.map((x,i)=>'<article class="picking-line-card" data-di-row="'+i+'"><div class="form-grid"><div><label>SKU</label><input data-di-field="sku" value="'+escapeHtml(x.sku)+'"></div><div><label>ชื่อรายการ</label><input data-di-field="name" value="'+escapeHtml(x.name)+'"></div><div><label>จำนวน</label><input data-di-field="quantity" type="number" min="0" step="1" value="'+x.quantity+'"></div></div><p class="muted">หน่วย: '+escapeHtml(x.unit||'—')+(x.price!==null&&x.price!==undefined?' · ราคา/หน่วย: '+escapeHtml(x.price):'')+(x.discount?' · ส่วนลด: '+escapeHtml(x.discount):'')+' · แหล่งข้อมูล: '+escapeHtml(x.source_sheet?x.source_sheet+' แถว '+x.source_row:'PDF')+'</p><label style="display:flex;align-items:center;gap:8px;margin-top:8px"><input data-di-field="inventory" type="checkbox" '+(x.is_inventory?'checked':'')+' style="width:auto"> นับเป็นสินค้าในคลัง (ยกเลิกสำหรับค่าบริการ)</label></article>').join(''):'<p class="error">ยังไม่พบรายการสินค้า กรุณาตรวจสอบเอกสาร</p>';
   $('documentImportReview').classList.remove('hidden');
 }
 async function readPdf(file){
   if(!window.pdfjsLib)throw new Error('โหลดตัวอ่าน PDF ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่');
   window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
   const data=new Uint8Array(await file.arrayBuffer()),pdf=await window.pdfjsLib.getDocument({data}).promise,pages=[];
   for(let p=1;p<=pdf.numPages;p++){
     const page=await pdf.getPage(p),viewport=page.getViewport({scale:1}),content=await page.getTextContent(),items=[];
     for(const x of content.items){
       if(!x.str||!x.str.trim())continue;
       const point=viewport.convertToViewportPoint(x.transform[4],x.transform[5]);
       items.push({str:x.str,x:point[0],y:point[1]});
     }
     pages.push(items);
   }
   return pages;
 }
 fileInput.addEventListener('change',async()=>{
   const file=fileInput.files?.[0];if(!file)return;
   $('documentImportReview').classList.add('hidden');$('documentImportWarnings').classList.add('hidden');
   const isExcel=/\.(xlsx|xls)$/i.test(file.name);
   setStatus((isExcel?'กำลังอ่าน Excel ทุกแถวและทุก Worksheet: ':'กำลังอ่าน PDF: ')+file.name+' ...');
   try{
     let parsed;
     if(isExcel){
       if(!window.XLSX)throw new Error('ยังโหลดตัวอ่าน Excel ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่');
       const data=await file.arrayBuffer();
       const workbook=XLSX.read(data,{type:'array',cellDates:false,cellText:true});
       parsed=parseExcel(workbook);
     }else{
       const pages=await readPdf(file);
       if(!pages.some(p=>p.length)){setStatus('ไฟล์นี้ไม่มีข้อความให้อ่าน อาจเป็น PDF แบบภาพสแกน รุ่นนี้ยังไม่รองรับ OCR',true);return;}
       parsed=parsePositioned(pages);
     }
     if(parsed.number)seenDocumentNumbers.add(parsed.number);
     render(parsed);
     setStatus('อ่าน '+(isExcel?'Excel':'PDF')+' เสร็จแล้ว · พบ '+parsed.items.length+' รายการ'+(parsed.sourceSheets?.length?' จาก '+parsed.sourceSheets.length+' Worksheet':'')+' · กรุณาตรวจสอบทุกช่อง · ไม่มีการบันทึกข้อมูล');
   }catch(e){setStatus('อ่านไฟล์ไม่สำเร็จ: '+(e?.message||e),true);}
 });
 $('documentImportLines').addEventListener('input',e=>{
   const row=e.target.closest('[data-di-row]');if(!row)return;
   if(e.target.dataset.diField==='quantity'&&Number(e.target.value)<0)e.target.value='0';
 });
 $('documentImportResetBtn').addEventListener('click',()=>{
   fileInput.value='';$('documentImportReview').classList.add('hidden');$('documentImportWarnings').classList.add('hidden');setStatus('ล้างผลการอ่านแล้ว กรุณาเลือกไฟล์ Excel หรือ PDF ใหม่');
 });

})();