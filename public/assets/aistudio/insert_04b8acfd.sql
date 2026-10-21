insert into 
  rss_articles (
    id, 
    feed_title, 
    title, 
    url, 
    author, 
    clean_content, 
    "group", 
    published_at, 
    fetched_at, 
    vector_indexed, 
    freshrss_id
  )
values
  (
    $id, 
    $feed_title, 
    $title, 
    $url, 
    $author, 
    $clean_content, 
    $group, 
    $published_at, 
    $fetched_at, 
    $vector_indexed, 
    $freshrss_id
  );