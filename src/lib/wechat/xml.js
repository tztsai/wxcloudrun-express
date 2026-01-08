function decodeCdata(text) {
    return (text ?? '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

export function xmlGetText(xml, tag) {
    // Supports <Tag><![CDATA[text]]></Tag> and <Tag>text</Tag>
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = xml.match(re);
    if (!match) return '';
    const raw = match[1].trim();
    const cdataMatch = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdataMatch) return cdataMatch[1];
    return decodeCdata(raw);
}

function escapeCdata(text) {
    // Prevent closing CDATA injection.
    return String(text).replace(/\]\]>/g, ']]&gt;');
}

export function xmlTextReply({ toUser, fromUser, content }) {
    const now = Math.floor(Date.now() / 1000);
    return `<?xml version="1.0" encoding="UTF-8"?>
<xml>
	<ToUserName><![CDATA[${escapeCdata(toUser)}]]></ToUserName>
	<FromUserName><![CDATA[${escapeCdata(fromUser)}]]></FromUserName>
	<CreateTime>${now}</CreateTime>
	<MsgType><![CDATA[text]]></MsgType>
	<Content><![CDATA[${escapeCdata(content)}]]></Content>
</xml>`;
}
